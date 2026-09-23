/**
 * Tests for the extract pipeline: the ZIP reader, the table reader, and the
 * workbook writer.
 *
 * These three are the parts of the `tables` target that are ours - no
 * LibreOffice, no rasteriser, nothing outside this process - so a fault in any
 * of them is a fault in code we ship rather than in a package a host may or
 * may not have installed. That makes them worth pinning down precisely, and it
 * is why the merge cases below are exhaustive: mis-expanding a merged cell
 * produces a workbook that opens, looks plausible, and is silently wrong,
 * which is exactly the kind of failure a reader will not report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before config.ts is imported - see the note in helpers.ts.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-tables-'));

const { zipStored, zipDeflated } = await import('../src/lib/zip.ts');
const { readZipEntry } = await import('../src/lib/unzip.ts');
const { extractTables } = await import('../src/lib/docx-tables.ts');
const {
  buildXlsx,
  MAX_CELL_CHARACTERS,
  MAX_COLUMNS,
  MAX_ROWS,
  sanitiseSheetName,
  sheetNameFor,
  WorkbookLimitError,
} = await import('../src/lib/xlsx.ts');
const { decodeXmlText } = await import('../src/lib/xml-text.ts');

/** Wrap a body in the smallest document that is still a real document. */
function docxBody(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  );
}

function cell(text: string, properties = ''): string {
  const props = properties === '' ? '' : `<w:tcPr>${properties}</w:tcPr>`;
  return `<w:tc>${props}<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
}

function row(...cells: string[]): string {
  return `<w:tr>${cells.join('')}</w:tr>`;
}

function table(...rows: string[]): string {
  return `<w:tbl>${rows.join('')}</w:tbl>`;
}

const GENEROUS = 1_000_000;

/** Extract with both ceilings set far out of the way, for the cases about shape. */
function extract(xml: string, maxCells = GENEROUS, maxTables = GENEROUS) {
  return extractTables(xml, maxCells, maxTables);
}

describe('zip reader', () => {
  it('reads an entry that was stored', () => {
    const archive = zipStored([{ name: 'word/document.xml', data: Buffer.from('<hello/>') }]);
    const result = readZipEntry(archive, 'word/document.xml', 1024);
    assert.equal(result.kind, 'found');
    assert.equal(result.kind === 'found' && result.data.toString('utf8'), '<hello/>');
  });

  it('reads an entry that was deflated', () => {
    // The two methods put different sizes in the two size fields, and getting
    // that wrong is how an archive that unpacks to nothing gets built.
    const payload = Buffer.from('x'.repeat(4096));
    const archive = zipDeflated([{ name: 'xl/workbook.xml', data: payload }]);
    const result = readZipEntry(archive, 'xl/workbook.xml', 1024 * 1024);
    assert.equal(result.kind, 'found');
    assert.equal(result.kind === 'found' && result.data.length, 4096);
    assert.ok(result.kind === 'found' && result.data.equals(payload));
  });

  it('finds an entry among several, by exact name', () => {
    const archive = zipDeflated([
      { name: '[Content_Types].xml', data: Buffer.from('a') },
      { name: 'word/document.xml', data: Buffer.from('b') },
      { name: 'word/styles.xml', data: Buffer.from('c') },
    ]);
    const result = readZipEntry(archive, 'word/styles.xml', 1024);
    assert.equal(result.kind === 'found' && result.data.toString('utf8'), 'c');
  });

  it('is case-sensitive and does not match a prefix', () => {
    // ZIP names are case-sensitive, and a reader that matched loosely would
    // return the wrong part rather than nothing.
    const archive = zipStored([{ name: 'word/document.xml', data: Buffer.from('b') }]);
    assert.equal(readZipEntry(archive, 'word/Document.xml', 1024).kind, 'missing');
    assert.equal(readZipEntry(archive, 'word/document', 1024).kind, 'missing');
    assert.equal(readZipEntry(archive, 'word/', 1024).kind, 'missing');
  });

  it('reports a missing entry rather than throwing', () => {
    const archive = zipStored([{ name: 'a.txt', data: Buffer.from('a') }]);
    assert.equal(readZipEntry(archive, 'not-there.txt', 1024).kind, 'missing');
  });

  it('reports something that is not an archive at all', () => {
    // A legacy .doc, a .pdf, an empty upload: none is a ZIP, and all of them
    // arrive here the same way.
    assert.equal(readZipEntry(Buffer.alloc(0), 'word/document.xml', 1024).kind, 'missing');
    assert.equal(
      readZipEntry(Buffer.from('not a zip, just text'), 'word/document.xml', 1024).kind,
      'missing',
    );
    assert.equal(
      readZipEntry(Buffer.alloc(4096, 0x41), 'word/document.xml', 1024).kind,
      'missing',
    );
  });

  it('refuses an entry whose declared size is over the ceiling', () => {
    // Decompression bomb, first defence: the central directory states the
    // uncompressed size, so the refusal happens before any expanding is done.
    const archive = zipStored([{ name: 'word/document.xml', data: Buffer.alloc(50_000, 0x41) }]);
    const result = readZipEntry(archive, 'word/document.xml', 1024);
    assert.equal(result.kind, 'too-large');
    assert.equal(result.kind === 'too-large' && result.declaredBytes, 50_000);
  });

  it('refuses an entry that expands past the ceiling despite declaring less', () => {
    // Decompression bomb, second defence. The directory here is a LIE: the
    // declared size is patched down to 10 bytes, so only the inflate's own
    // output cap can stop it. This is the case a hostile archive is built for,
    // and the reason both checks exist rather than just the cheap one.
    const archive = zipDeflated([{ name: 'word/document.xml', data: Buffer.alloc(200_000, 0x41) }]);

    const centralAt = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(centralAt > 0, 'no central directory found to patch');
    archive.writeUInt32LE(10, centralAt + 24); // declared uncompressed size

    const result = readZipEntry(archive, 'word/document.xml', 4096);
    assert.equal(result.kind, 'too-large');
  });

  it('does not follow a name out of the archive', () => {
    // The reader resolves a name to bytes and never to a path, so an entry
    // called `../../etc/passwd` is simply an entry no caller asks for.
    const archive = zipStored([{ name: 'etc/passwd', data: Buffer.from('nope') }]);
    assert.equal(readZipEntry(archive, '../../etc/passwd', 1024).kind, 'missing');
  });
});

describe('table extraction', () => {
  it('reads a plain table', () => {
    const xml = docxBody(table(row(cell('H1'), cell('H2')), row(cell('a'), cell('b'))));
    const result = extract(xml);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' && result.tables, [
      [
        ['H1', 'H2'],
        ['a', 'b'],
      ],
    ]);
  });

  it('expands a horizontal merge across every column it covers', () => {
    // gridSpan moves every later cell in the row to the right, so getting it
    // wrong misaligns the rest of the row rather than just the merged cell.
    const xml = docxBody(
      table(
        row(cell('Spanning', '<w:gridSpan w:val="3"/>')),
        row(cell('a'), cell('b'), cell('c')),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['Spanning', 'Spanning', 'Spanning'],
      ['a', 'b', 'c'],
    ]);
  });

  it('carries a vertical merge down from the cell that started it', () => {
    // The continuing cells are EMPTY in the XML - the value only exists in the
    // cell that restarts the merge, so it has to be carried by column.
    const xml = docxBody(
      table(
        row(cell('Merged', '<w:vMerge w:val="restart"/>'), cell('r1c2')),
        row(cell('', '<w:vMerge/>'), cell('r2c2')),
        row(cell('', '<w:vMerge/>'), cell('r3c2')),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['Merged', 'r1c2'],
      ['Merged', 'r2c2'],
      ['Merged', 'r3c2'],
    ]);
  });

  it('keeps a vertical merge in its own column', () => {
    // A merge in column 1 must not leak into column 0 of the next row, which
    // is what happens when the carry is tracked per row instead of per column.
    const xml = docxBody(
      table(
        row(cell('plain'), cell('Merged', '<w:vMerge w:val="restart"/>'), cell('x')),
        row(cell('plain2'), cell('', '<w:vMerge/>'), cell('y')),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['plain', 'Merged', 'x'],
      ['plain2', 'Merged', 'y'],
    ]);
  });

  it('restarts the carry at a new cell with its own text', () => {
    const xml = docxBody(
      table(
        row(cell('first', '<w:vMerge w:val="restart"/>')),
        row(cell('', '<w:vMerge/>')),
        row(cell('second', '<w:vMerge w:val="restart"/>')),
        row(cell('', '<w:vMerge/>')),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['first'],
      ['first'],
      ['second'],
      ['second'],
    ]);
  });

  it('handles a merge that is also a horizontal span', () => {
    const xml = docxBody(
      table(
        row(cell('wide', '<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>'), cell('tail')),
        row(cell('', '<w:vMerge/>'), cell('', '<w:vMerge/>'), cell('tail2')),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['wide', 'wide', 'tail'],
      ['wide', 'wide', 'tail2'],
    ]);
  });

  it('reports a nested table as its own table, after its parent', () => {
    const inner = table(row(cell('inner')));
    const outer = table(row(`<w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>${inner}</w:tc>`));
    const result = extractTables(docxBody(outer), GENEROUS, GENEROUS);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' && result.tables, [[['outer']], [['inner']]]);
  });

  it('joins the paragraphs inside one cell with a newline', () => {
    const xml = docxBody(
      table(
        row(
          '<w:tc><w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p></w:tc>',
        ),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['one\ntwo']]);
  });

  it('joins the runs within one paragraph without a separator', () => {
    // Two runs in a paragraph are one word to a reader: Word splits runs on
    // formatting, not on meaning, so inserting anything here would corrupt
    // every word that happens to be bolded.
    const xml = docxBody(
      table(
        row(
          '<w:tc><w:p><w:r><w:t>bold</w:t></w:r><w:r><w:t>rest</w:t></w:r></w:p></w:tc>',
        ),
      ),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['boldrest']]);
  });

  it('decodes escaped and numeric entities', () => {
    const xml = docxBody(
      table(row(cell('a &amp; b'), cell('caf&#233;'), cell('&#xE9;tude'), cell('&lt;tag&gt;'))),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [
      ['a & b', 'café', 'étude', '<tag>'],
    ]);
  });

  it('trims the whitespace a cell carries around its text', () => {
    const xml = docxBody(table(row(cell('  padded  '), cell('\n newline \n'))));
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['padded', 'newline']]);
  });

  it('treats an empty paragraph as an empty cell', () => {
    const xml = docxBody(table(row('<w:tc><w:p/></w:tc>', cell('b'))));
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['', 'b']]);
  });

  it('ignores prose and finds only the tables', () => {
    const xml = docxBody(
      '<w:p><w:r><w:t>before</w:t></w:r></w:p>' +
        table(row(cell('only'))) +
        '<w:p><w:r><w:t>after</w:t></w:r></w:p>',
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables, [[['only']]]);
  });

  it('finds nothing in a document with no tables', () => {
    const xml = docxBody('<w:p><w:r><w:t>just prose</w:t></w:r></w:p>');
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables, []);
  });

  it('drops a table that has no rows', () => {
    const xml = docxBody(table() + table(row(cell('real'))));
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables, [[['real']]]);
  });

  it('refuses a document over the cell ceiling', () => {
    const rows = Array.from({ length: 10 }, () => row(cell('a'), cell('b'), cell('c')));
    const result = extract(docxBody(table(...rows)), 20);
    assert.equal(result.kind, 'too-large');
    assert.ok(result.kind === 'too-large' && result.count > 20);
    assert.equal(result.kind === 'too-large' && result.reason, 'cells');
  });

  it('refuses a document over the table ceiling, however empty the tables are', () => {
    // The cell ceiling cannot catch this one: a document of empty tables costs
    // a retained frame per table and no cells at all, and a million of them fit
    // inside the XML ceiling while growing the heap by hundreds of megabytes.
    const xml = docxBody('<w:tbl></w:tbl>'.repeat(500));
    const result = extract(xml, GENEROUS, 100);
    assert.equal(result.kind, 'too-large');
    assert.equal(result.kind === 'too-large' && result.reason, 'tables');
    assert.ok(result.kind === 'too-large' && result.count > 100);
  });

  it('charges every row against the ceiling, including empty ones', () => {
    // `<w:tr></w:tr>` repeated is free by cell count and expensive in memory:
    // 300,000 of them are retained arrays that contain nothing, and a version
    // of this that only counted cells reported a clean extraction of an empty
    // table while doing it.
    const xml = docxBody(`<w:tbl>${'<w:tr></w:tr>'.repeat(300_000)}</w:tbl>`);
    const result = extract(xml, 200_000, 1_000);
    assert.equal(result.kind, 'too-large');
    assert.equal(result.kind === 'too-large' && result.reason, 'cells');
  });

  it('clamps an absurd horizontal span instead of trusting it', () => {
    // The span is attacker-controlled and is the bound of the loop that fills
    // the row. Unclamped, `w:val="99999999999999999999"` threw
    // `RangeError: Invalid array length` straight out of the pipeline - a 500
    // from a 200-byte upload - and a value just under 2^32 spun the event loop
    // instead. Nothing wider than a worksheet can be represented anyway.
    const xml = docxBody(
      table(row(cell('wide', '<w:gridSpan w:val="99999999999999999999"/>'))),
    );
    const result = extract(xml, GENEROUS, GENEROUS);
    assert.equal(result.kind, 'ok');
    const row_ = result.kind === 'ok' ? result.tables[0]?.[0] : undefined;
    // Clamped to Excel's column count, so the row is exactly that wide and
    // every position in it holds the value.
    assert.equal(row_?.length, 16_384);
    assert.equal(row_?.[0], 'wide');
    assert.equal(row_?.[16_383], 'wide');
  });

  it('does not let a nonsense span consume the cell budget unnoticed', () => {
    // The clamp has to be small enough that a single cell cannot blow through
    // the ceiling between two checks, which happen once per tag.
    const xml = docxBody(
      table(row(cell('a', '<w:gridSpan w:val="4000000000"/>')), row(cell('b'))),
    );
    const result = extract(xml, 100, GENEROUS);
    assert.equal(result.kind, 'too-large');
  });

  it('treats a self-closing cell as an empty cell in its own column', () => {
    // `<w:tc/>` left open is overwritten by the next `<w:tc>`, which loses the
    // cell and shifts every later cell in the row one place left - precisely
    // the misalignment class this module exists to get right.
    const xml = docxBody(table(row('<w:tc/>', cell('B'), cell('C'))));
    const result = extract(xml, GENEROUS, GENEROUS);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['', 'B', 'C']]);
  });

  it('treats a self-closing row as an empty row rather than losing it', () => {
    const xml = docxBody(table(row(cell('first')), '<w:tr/>', row(cell('third'))));
    const result = extract(xml, GENEROUS, GENEROUS);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['first'], [], ['third']]);
  });

  it('does not let a self-closing table swallow the rest of the document', () => {
    // `<w:tbl/>` left on the open stack makes every element after it read as
    // being inside a table, so a table later in the body is never seen as one.
    const xml = docxBody('<w:tbl/>' + table(row(cell('after'))));
    const result = extract(xml, GENEROUS, GENEROUS);
    assert.deepEqual(result.kind === 'ok' && result.tables, [[['after']]]);
  });

  it('does not run away on a truncated document', () => {
    // A document cut off mid-tag must not hang or throw: it is a corrupt file
    // and the answer is whatever was complete.
    const truncated = docxBody(table(row(cell('complete'), cell('half')).slice(0, -6)));
    const result = extract(truncated);
    assert.equal(result.kind, 'ok');
  });

  it('is not confused by an attribute containing a closing bracket', () => {
    // Quote-aware tag scanning: reading this `>` as the end of the tag would
    // desynchronise the scan for the whole rest of the document.
    const xml = docxBody(
      table(row(cell('after', '<w:gridSpan w:val="1"/>')), row(cell('still here'))),
    );
    const result = extract(xml);
    assert.deepEqual(result.kind === 'ok' && result.tables[0], [['after'], ['still here']]);
  });
});

describe('workbook writer', () => {
  /** Read a part back out of a workbook we just built. */
  function part(workbook: Buffer, name: string): string {
    const result = readZipEntry(workbook, name, 1024 * 1024);
    assert.equal(result.kind, 'found', `${name} is not in the workbook`);
    return result.kind === 'found' ? result.data.toString('utf8') : '';
  }

  it('writes every part a reader needs', () => {
    const workbook = buildXlsx([{ name: 'Table_1', rows: [['a']] }]);
    for (const name of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(part(workbook, name).length > 0, `${name} is empty`);
    }
  });

  it('points the package at the workbook with the officeDocument relationship', () => {
    // The bug this catches is subtle and total: declaring officeDocument in
    // the PACKAGE relationship namespace produces a package that unzips
    // cleanly, looks right part by part, and that no reader will open.
    const rels = part(buildXlsx([{ name: 'T', rows: [] }]), '_rels/.rels');
    assert.match(
      rels,
      /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/officeDocument"/,
    );
  });

  it('declares a content type for every sheet it writes', () => {
    const types = part(buildXlsx([{ name: 'A', rows: [] }, { name: 'B', rows: [] }]), '[Content_Types].xml');
    assert.match(types, /PartName="\/xl\/worksheets\/sheet1\.xml"/);
    assert.match(types, /PartName="\/xl\/worksheets\/sheet2\.xml"/);
  });

  it('gives every sheet a matching relationship', () => {
    const rels = part(
      buildXlsx([{ name: 'A', rows: [] }, { name: 'B', rows: [] }]),
      'xl/_rels/workbook.xml.rels',
    );
    assert.match(rels, /Id="rId1"[^>]*Target="worksheets\/sheet1\.xml"/);
    assert.match(rels, /Id="rId2"[^>]*Target="worksheets\/sheet2\.xml"/);
  });

  it('writes one worksheet part per sheet', () => {
    const workbook = buildXlsx([{ name: 'A', rows: [] }, { name: 'B', rows: [] }]);
    assert.match(part(workbook, 'xl/workbook.xml'), /name="A"/);
    assert.match(part(workbook, 'xl/workbook.xml'), /name="B"/);
    assert.equal(readZipEntry(workbook, 'xl/worksheets/sheet3.xml', 1024).kind, 'missing');
  });

  it('names columns in bijective base 26', () => {
    // Past Z the counting is not base 26: there is no zero digit, so getting
    // it wrong shifts every column of a wide table by one.
    const wide = Array.from({ length: 28 }, (_value, index) => `c${index}`);
    const sheet = part(buildXlsx([{ name: 'T', rows: [wide] }]), 'xl/worksheets/sheet1.xml');
    assert.match(sheet, /r="A1"/);
    assert.match(sheet, /r="Z1"/);
    assert.match(sheet, /r="AA1"/);
    assert.match(sheet, /r="AB1"/);
  });

  it('omits empty cells so a sparse row cannot slide', () => {
    // Every cell carries its own reference precisely because the rows are
    // sparse: without them a reader infers position from order and the gap
    // silently closes.
    const sheet = part(
      buildXlsx([{ name: 'T', rows: [['a', '', 'c']] }]),
      'xl/worksheets/sheet1.xml',
    );
    assert.match(sheet, /r="A1"/);
    assert.match(sheet, /r="C1"/);
    assert.equal(/r="B1"/.test(sheet), false);
  });

  it('numbers rows from one and keeps their positions', () => {
    const sheet = part(
      buildXlsx([{ name: 'T', rows: [['a'], [''], ['c']] }]),
      'xl/worksheets/sheet1.xml',
    );
    assert.match(sheet, /<row r="1">/);
    assert.match(sheet, /<row r="2">/);
    assert.match(sheet, /<row r="3">/);
    assert.match(sheet, /r="A3"/);
  });

  it('escapes markup so text cannot break the document', () => {
    const sheet = part(
      buildXlsx([{ name: 'T', rows: [['a & b', '<tag>', 'q"q']] }]),
      'xl/worksheets/sheet1.xml',
    );
    assert.match(sheet, /a &amp; b/);
    assert.match(sheet, /&lt;tag&gt;/);
    assert.equal(sheet.includes('<tag>'), false);
  });

  it('preserves whitespace in a cell', () => {
    // Without xml:space a reader is free to strip it, and the last cell of a
    // table is exactly where a person types trailing spaces.
    const sheet = part(
      buildXlsx([{ name: 'T', rows: [['  padded  ']] }]),
      'xl/worksheets/sheet1.xml',
    );
    assert.match(sheet, /<t xml:space="preserve">  padded  <\/t>/);
  });

  it('accepts a cell at the limit and refuses one past it', () => {
    // Excel refuses the whole workbook for a single over-long cell, so the
    // writer refuses rather than truncating: a silently shortened cell is the
    // user's own words going missing.
    const atLimit = 'x'.repeat(MAX_CELL_CHARACTERS);
    assert.ok(buildXlsx([{ name: 'T', rows: [[atLimit]] }]).length > 0);

    const tooLong = 'x'.repeat(MAX_CELL_CHARACTERS + 1);
    assert.throws(
      () => buildXlsx([{ name: 'T', rows: [[tooLong]] }]),
      (error: unknown) => error instanceof WorkbookLimitError && error.limit === 'cell-characters',
    );
  });

  it('refuses a worksheet taller or wider than Excel can hold', () => {
    // Refused rather than truncated. Dropping the rows past the limit would
    // answer 200 with a workbook quietly missing the end of a table, which the
    // person receiving it has no way to notice.
    // One shared row rather than a million of them: the check is on the number
    // of rows, and building them all just to count them would make this the
    // most memory-hungry test in the suite.
    const oneRow = ['x'];
    const tall = new Array<string[]>(MAX_ROWS + 1).fill(oneRow);
    assert.throws(
      () => buildXlsx([{ name: 'T', rows: tall }]),
      (error: unknown) => error instanceof WorkbookLimitError && error.limit === 'rows',
    );

    const wide = [new Array<string>(MAX_COLUMNS + 1).fill('x')];
    assert.throws(
      () => buildXlsx([{ name: 'T', rows: wide }]),
      (error: unknown) => error instanceof WorkbookLimitError && error.limit === 'columns',
    );
  });

  it('does not write a character XML cannot carry', () => {
    // A C0 control other than tab/newline/return is not a legal XML character,
    // so writing one makes the worksheet not well-formed - which a reader
    // answers by refusing the whole workbook, costing the user every table
    // because of one stray byte.
    const illegal = ['a\u000bb', 'c\u0000d', 'e\u0008f'];
    const sheet = part(buildXlsx([{ name: 'T', rows: [illegal] }]), 'xl/worksheets/sheet1.xml');
    for (const character of ['\u000b', '\u0000', '\u0008']) {
      assert.equal(sheet.includes(character), false, `${JSON.stringify(character)} was written out`);
    }
    assert.match(sheet, /ab/);
    assert.match(sheet, /cd/);
    assert.match(sheet, /ef/);
  });
});

describe('xml text decoding', () => {
  it('decodes the predefined entities and numeric references', () => {
    assert.equal(decodeXmlText('a &amp; b'), 'a & b');
    assert.equal(decodeXmlText('&lt;tag&gt;'), '<tag>');
    assert.equal(decodeXmlText('caf&#233;'), 'café');
    assert.equal(decodeXmlText('&#xE9;tude'), 'étude');
    assert.equal(decodeXmlText('a&nbsp;b'), 'a b');
  });

  it('leaves an entity it does not know as written', () => {
    // A document declaring its own entities cannot be resolved without a
    // parser, and dropping the text would lose the user's words. Leaving it
    // visible is wrong-but-honest; the writer escapes the ampersand so the
    // workbook stays well-formed.
    assert.equal(decodeXmlText('&weird; thing'), '&weird; thing');
    assert.equal(decodeXmlText('100% & more'), '100% & more');
  });

  it('refuses to produce a character XML forbids', () => {
    // These would otherwise be written into the worksheet as raw control
    // characters, which is not well-formed XML.
    for (const reference of ['&#11;', '&#0;', '&#8;', '&#14;', '&#xD800;', '&#xFFFF;']) {
      assert.equal(decodeXmlText(reference), reference, `${reference} was decoded`);
    }
    // Tab, newline and carriage return are legal, so they still resolve.
    assert.equal(decodeXmlText('&#9;'), '\t');
    assert.equal(decodeXmlText('&#10;'), '\n');
    assert.equal(decodeXmlText('&#13;'), '\r');
  });

  it('resolves astral characters rather than splitting them', () => {
    assert.equal(decodeXmlText('&#x1F600;'), '😀');
  });
});

describe('sheet names', () => {
  it('numbers the sheets it generates', () => {
    const taken = new Set<string>();
    assert.equal(sheetNameFor(1, taken), 'Table_1');
    assert.equal(sheetNameFor(2, taken), 'Table_2');
  });

  it('keeps names unique, treating them case-insensitively', () => {
    // Excel compares sheet names case-insensitively, so a workbook holding
    // both `Table_1` and `table_1` is one it offers to repair.
    const taken = new Set<string>();
    taken.add('table_1');
    assert.equal(sheetNameFor(1, taken), 'Table_1_2');
    assert.equal(sheetNameFor(1, taken), 'Table_1_3');
    // The suffixed name has to stay inside the 31-character budget too.
    assert.ok([...taken].every((name) => name.length <= 31));
  });

  it('replaces the characters Excel refuses rather than escaping them', () => {
    // Excel rejects these outright, so a name carrying one makes the whole
    // workbook unopenable rather than merely odd-looking.
    assert.equal(sanitiseSheetName('a[b]c:d*e?f/g\\h'), 'a_b_c_d_e_f_g_h');
  });

  it('caps a name at 31 characters', () => {
    assert.equal(sanitiseSheetName('x'.repeat(60)).length, 31);
  });

  it('never produces an empty name', () => {
    assert.equal(sanitiseSheetName(''), 'Table');
    assert.equal(sanitiseSheetName('///'), '___');
  });

  it('leaves an ordinary name alone', () => {
    assert.equal(sanitiseSheetName('Table_1'), 'Table_1');
  });
});

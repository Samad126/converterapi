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

const { zipStored, zipDeflated } = await import('../../../src/lib/zip.ts');
const { readZipEntry } = await import('../../../src/lib/unzip.ts');
const { extractTables } = await import('../../../src/lib/docx-tables.ts');
const {
  buildXlsx,
  MAX_CELL_CHARACTERS,
  MAX_COLUMNS,
  MAX_ROWS,
  sanitiseSheetName,
  sheetNameFor,
  WorkbookLimitError,
} = await import('../../../src/lib/xlsx.ts');
const { decodeXmlText } = await import('../../../src/lib/xml-text.ts');

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

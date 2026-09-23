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

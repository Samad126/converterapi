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

/**
 * Writing a minimal .xlsx workbook, from scratch.
 *
 * An .xlsx is a ZIP of XML parts, and a workbook that only holds text needs
 * five kinds of part rather than the full spreadsheet vocabulary: the content
 * types, the package relationships, the workbook, its relationship to each
 * worksheet, and the worksheets themselves. That is small enough to write
 * directly - which is the same judgement `probe-documents.ts` makes when it
 * builds a .docx by hand rather than taking a document library.
 *
 * Two decisions are worth knowing about.
 *
 * 1. STRINGS ARE INLINE (`t="inlineStr"`), not held in a shared string table.
 *    A real sharedStrings part would let repeated values be stored once, and a
 *    Word table is exactly the sort of thing that repeats values - but the
 *    table would have to be built and indexed across every sheet before a
 *    single cell could be written, and the saving is a few percent on a file
 *    that is already deflated. Inline is the honest trade here.
 *
 * 2. EMPTY CELLS ARE OMITTED, which makes each row sparse. That is legal, but
 *    only because every cell we do write carries its own reference
 *    (`r="C7"`): without the reference a reader infers position from order,
 *    and a sparse row would slide its values left. This is the single easiest
 *    way to produce a workbook that looks right in one reader and is silently
 *    wrong in another, so the references are not optional.
 */
import { zipDeflated, type ZipEntry } from './zip.ts';
import { isLegalXmlCharacter } from './xml-text.ts';

export interface XlsxSheet {
  /** Already sanitised by `sheetNameFor` - ≤31 characters, unique. */
  name: string;
  /** Row-major cell text. Rows may be ragged; empty strings are skipped. */
  rows: readonly (readonly string[])[];
}

/**
 * Excel's own limits, and the reason the extractor has to bound anything at
 * all: a worksheet holds at most this many rows, and past them the file is
 * one Excel refuses to open rather than one that is merely large.
 */
export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;

/**
 * Longest text Excel will hold in one cell.
 *
 * A Word table cell has no such limit, so this is reachable, and past it Excel
 * refuses the whole workbook rather than the one cell. Truncating instead would
 * be a silent loss of the user's own words, so a cell this long is refused and
 * the caller turns it into an error the person can act on.
 */
export const MAX_CELL_CHARACTERS = 32_767;

/**
 * The caller asked for a worksheet Excel cannot hold.
 *
 * Past these the file is not merely large, it is one Excel refuses to open -
 * so the writer refuses first rather than truncating and reporting success,
 * which would hand the user a workbook quietly missing rows off the end.
 *
 * The field is declared and assigned rather than written as a constructor
 * parameter property: this project runs TypeScript through Node's type
 * stripping, which only erases annotations and cannot emit the assignment a
 * parameter property needs. `tsc` accepts both, so the difference only shows up
 * at runtime.
 */
export class WorkbookLimitError extends Error {
  readonly limit: 'cell-characters' | 'rows' | 'columns';

  constructor(limit: 'cell-characters' | 'rows' | 'columns', detail: string) {
    super(detail);
    this.name = 'WorkbookLimitError';
    this.limit = limit;
  }
}

/** What Excel allows in a sheet name: these are refused outright, not escaped. */
const ILLEGAL_SHEET_NAME = /[[\]:*?/\\]/g;
const MAX_SHEET_NAME_CHARACTERS = 31;

/**
 * Apply Excel's rules for a sheet name to whatever base is being used.
 *
 * Excel rejects `[ ] : * ? / \` outright rather than escaping them, refuses
 * anything over 31 characters, and refuses an empty name - so a base carrying
 * any of those makes the entire workbook unopenable rather than merely ugly.
 *
 * The bases generated today are `Table_N` and cannot trip any of this. It is
 * separate from `sheetNameFor` because the day the name becomes a caption read
 * out of the document it will be attacker-controlled and unbounded, and the
 * behaviour needs to already be right - and pinned by a test - before that
 * happens rather than after.
 */
export function sanitiseSheetName(base: string): string {
  const cleaned = base.replace(ILLEGAL_SHEET_NAME, '_').slice(0, MAX_SHEET_NAME_CHARACTERS);
  return cleaned === '' ? 'Table' : cleaned;
}

/**
 * A usable sheet name for the nth table, unique within the workbook.
 *
 * Uniqueness is compared case-insensitively because Excel treats sheet names
 * that way: `Table_1` and `table_1` in one workbook is a file Excel offers to
 * repair rather than one it opens.
 */
export function sheetNameFor(index: number, taken: Set<string>): string {
  const base = sanitiseSheetName(`Table_${index}`);

  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    const tail = `_${suffix}`;
    candidate = base.slice(0, MAX_SHEET_NAME_CHARACTERS - tail.length) + tail;
    suffix += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function buildXlsx(sheets: readonly XlsxSheet[]): Buffer {
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: text(part('Types', contentTypes(sheets), CONTENT_TYPES_NS)),
    },
    {
      name: '_rels/.rels',
      data: text(part('Relationships', rootRelationships(), PACKAGE_RELATIONSHIPS_NS_DECL)),
    },
    { name: 'xl/workbook.xml', data: text(part('workbook', workbook(sheets), WORKBOOK_NS)) },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        part('Relationships', workbookRelationships(sheets), PACKAGE_RELATIONSHIPS_NS_DECL),
      ),
    },
  ];

  sheets.forEach((sheet, index) => {
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: text(part('worksheet', sheetData(sheet.rows), WORKSHEET_NS)),
    });
  });

  return zipDeflated(entries);
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** The relationship vocabulary, used both as a namespace and inside Type URIs. */
const PACKAGE_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PACKAGE_RELATIONSHIPS_NS_DECL = `xmlns="${PACKAGE_RELATIONSHIPS_NS}"`;
const CONTENT_TYPES_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"';
/**
 * The officeDocument relationship is NOT in the package vocabulary above, even
 * though it lives in the same file. It has its own namespace, and getting it
 * wrong produces a package that unzips cleanly, looks convincing part by part,
 * and that every reader refuses to open - which is exactly what happened the
 * first time this file was run.
 */
const OFFICE_DOCUMENT_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const WORKBOOK_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WORKSHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

function part(name: string, inner: string, namespaces = ''): string {
  const attributes = namespaces === '' ? '' : ` ${namespaces}`;
  return `${XML_DECLARATION}\n<${name}${attributes}>${inner}</${name}>`;
}

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

/**
 * The package manifest: which part is which, and what media type it has.
 *
 * Every worksheet needs an `Override`, because the default for `.xml` here is
 * `application/xml` and Excel will not open a workbook whose sheets claim to
 * be generic XML.
 */
function contentTypes(sheets: readonly XlsxSheet[]): string {
  const overrides = sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    )
    .join('');

  return (
    '<Default Extension="rels" ' +
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides
  );
}

/** The one relationship from the package root: where the workbook lives. */
function rootRelationships(): string {
  return (
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" ` +
    'Target="xl/workbook.xml"/>'
  );
}

/**
 * The workbook: one `<sheet>` per worksheet, each pointing at its part by
 * relationship id. A sheet listed here with no matching relationship, or the
 * other way round, is a workbook Excel offers to repair - so both are built
 * from the same array in the same order.
 */
function workbook(sheets: readonly XlsxSheet[]): string {
  const sheetElements = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  return `<sheets>${sheetElements}</sheets>`;
}

function workbookRelationships(sheets: readonly XlsxSheet[]): string {
  return sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
}

function sheetData(rows: readonly (readonly string[])[]): string {
  const parts: string[] = ['<sheetData>'];

  if (rows.length > MAX_ROWS) {
    throw new WorkbookLimitError(
      'rows',
      `worksheet holds ${rows.length} rows, over Excel's ${MAX_ROWS}`,
    );
  }

  rows.forEach((row, rowIndex) => {
    if (row.length > MAX_COLUMNS) {
      throw new WorkbookLimitError(
        'columns',
        `worksheet row ${rowIndex + 1} holds ${row.length} columns, over Excel's ${MAX_COLUMNS}`,
      );
    }
    // Excel numbers rows and columns from 1.
    const number = rowIndex + 1;
    parts.push(`<row r="${number}">`);

    row.forEach((value, columnIndex) => {
      if (value === '') return;
      if (value.length > MAX_CELL_CHARACTERS) {
        throw new WorkbookLimitError(
          'cell-characters',
          `cell text of ${value.length} characters exceeds Excel's ${MAX_CELL_CHARACTERS}`,
        );
      }
      // `xml:space="preserve"` on every string: without it a reader is free to
      // strip leading and trailing whitespace, which is exactly the whitespace
      // a person typed into the last cell of a table.
      parts.push(
        `<c r="${columnName(columnIndex)}${number}" t="inlineStr"><is>` +
          `<t xml:space="preserve">${escapeText(value)}</t></is></c>`,
      );
    });

    parts.push('</row>');
  });

  parts.push('</sheetData>');
  return parts.join('');
}

/**
 * A zero-based column index as a spreadsheet letter: 0 is `A`, 26 is `AA`.
 *
 * Bijective base 26, which is not the same as base 26 - there is no zero
 * digit, so the counting happens after decrementing rather than before. Get
 * that wrong and the file is valid XML with every column one to the left.
 */
function columnName(index: number): string {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/**
 * Escape text for a worksheet, and drop anything XML cannot carry at all.
 *
 * The escape half is the obvious one. The filter is the second net: a raw
 * control character can reach here either as a numeric reference the decoder
 * refused to resolve or as a literal byte in a document that was never valid
 * XML to begin with, and writing one out produces a package that is not
 * well-formed. A reader's answer to that is to refuse the whole workbook, so a
 * single stray byte in one cell would cost the user every table they asked for.
 */
function escapeText(value: string): string {
  const legal = stripIllegalXmlCharacters(value);
  return legal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripIllegalXmlCharacters(value: string): string {
  let cleaned = '';
  for (const character of value) {
    if (isLegalXmlCharacter(character.codePointAt(0) ?? 0)) cleaned += character;
  }
  return cleaned;
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

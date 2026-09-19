/**
 * Pulling every table out of a WordprocessingML document.
 *
 * The logic here is a port of a script that was tested against real documents
 * until every merged-cell case came out right, and the merge handling is
 * deliberately preserved rather than reinvented: it is the part of the problem
 * that is actually hard, and the part most implementations get wrong.
 *
 * That said, this is NOT an XML parser and must not become one. It walks the
 * tag stream looking for the six names below and ignores everything else,
 * which is why it can be a few hundred lines where a general parser plus a
 * document model would be thousands. The cost of that choice is that it
 * depends on the `w:` prefix, which every OOXML producer emits - Word,
 * LibreOffice, and every library that generates .docx - because the prefix is
 * what the format's own examples and test suites use. A document that binds
 * the WordprocessingML namespace to some other prefix would read as having no
 * tables at all. That is a wrong answer rather than a crash, so it is written
 * down here rather than left to be discovered.
 *
 * The shapes that matter, all of which are covered by tests:
 *
 *   - `w:gridSpan` - one cell occupying N columns. It occupies them ALL, so
 *     the columns after it shift right; getting this wrong misaligns every
 *     later column in the row rather than just the merged one.
 *   - `w:vMerge` - a cell continuing the cell above it. `w:val="restart"`
 *     begins a merge, and a bare `<w:vMerge/>` continues one. The continued
 *     cell usually carries no text of its own, so its value has to be carried
 *     down from the cell that started the merge.
 *   - a nested `w:tbl` inside a cell, which is its own table.
 *
 * Merged cells are EXPANDED - the value is repeated across every position the
 * cell covers - so the grid matches what a person sees in Word. The cost is
 * that a merged cell's value appears more than once in the output, which is
 * the right default: the alternative is a grid with holes in it, and a hole in
 * a spreadsheet is indistinguishable from a cell nobody filled in.
 */
import { decodeXmlText } from './xml-text.ts';

/** The only tag names this understands. Everything else is skipped. */
const TAG_TABLE = 'w:tbl';
const TAG_ROW = 'w:tr';
const TAG_CELL = 'w:tc';
const TAG_PARAGRAPH = 'w:p';
const TAG_TEXT = 'w:t';
const TAG_GRID_SPAN = 'w:gridSpan';
const TAG_VERTICAL_MERGE = 'w:vMerge';

const ATTRIBUTE_VALUE = /(?:^|\s)w:val\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * The widest horizontal merge this will honour.
 *
 * A worksheet holds at most 16,384 columns, so a cell claiming to span more
 * than that cannot be represented no matter what we do with it - which makes
 * this the natural clamp for a value that comes straight from the document and
 * is otherwise unchecked. See `TAG_GRID_SPAN`.
 */
const MAX_GRID_SPAN = 16_384;

/** A cell's vertical merge state. `null` is an ordinary cell. */
type VerticalMerge = 'restart' | 'continue' | null;

interface CellState {
  /** One entry per paragraph; joined with a newline when the cell closes. */
  paragraphs: string[];
  /** The paragraph being accumulated, or null between paragraphs. */
  open: string | null;
  gridSpan: number;
  verticalMerge: VerticalMerge;
}

interface TableFrame {
  rows: string[][];
  row: string[] | null;
  cell: CellState | null;
  /**
   * Column index to the text of the cell that started a vertical merge there.
   *
   * Keyed by column because the cells of a merged run are not adjacent in the
   * XML - each row simply omits them - so the only thing tying a continuing
   * cell to the one above is the column it sits in.
   */
  carry: Map<number, string>;
  column: number;
}

export type TableExtraction =
  | { kind: 'ok'; tables: string[][][] }
  /**
   * More work than the caller will accept, counted as it happens.
   *
   * Two separate ceilings, because they catch different documents: a table
   * full of merged cells costs many cells and one table, while a document of
   * empty tables costs a frame each and no cells at all. Bounding only the
   * first leaves the second free to allocate without limit.
   */
  | { kind: 'too-large'; reason: 'cells' | 'tables'; count: number };

/**
 * Every table in `documentXml`, in document order, as a grid of cell text.
 *
 * Tables with no rows are dropped, and a nested table is reported after the
 * table that contains it - which is what the push-on-open below gives for
 * free, since a nested frame cannot be opened before its parent.
 */
export function extractTables(
  documentXml: string,
  maxCells: number,
  maxTables: number,
): TableExtraction {
  const frames: TableFrame[] = [];
  /** Open tables, innermost last. Empty means we are outside every table. */
  const open: TableFrame[] = [];
  /** Where the current `w:t`'s text starts, or -1 when not inside one. */
  let textStart = -1;
  let cells = 0;
  let tables = 0;

  const innermost = (): TableFrame | undefined => open[open.length - 1];

  /**
   * Close the innermost frame's current cell into its row.
   *
   * This is where the merge handling lives, and the order of the three steps
   * is what makes it correct: resolve the text first, then record it as the
   * carry for this column, then write it across every column the cell spans.
   */
  const closeCell = (frame: TableFrame): void => {
    const cell = frame.cell;
    if (!cell) return;

    // A cell whose last paragraph was never closed - `<w:p>` with no
    // `</w:p>` - still holds its text.
    if (cell.open !== null) cell.paragraphs.push(cell.open);
    let value = cell.paragraphs.join('\n').trim();

    if (cell.verticalMerge === 'continue') {
      // The value belongs to the cell above, which is the only copy of it.
      value = frame.carry.get(frame.column) ?? '';
    } else {
      // `restart`, or no merge at all. Both start a carry, because a cell
      // with no merge of its own may still be what the row below continues.
      frame.carry.set(frame.column, value);
    }

    const row = frame.row ?? (frame.row = []);
    for (let step = 0; step < cell.gridSpan; step += 1) {
      row[frame.column] = value;
      if (cell.verticalMerge === 'restart') frame.carry.set(frame.column, value);
      frame.column += 1;
      cells += 1;
    }

    frame.cell = null;
  };

  /**
   * Finish the innermost frame's current row.
   *
   * A row costs one against the cell budget even when it holds nothing, which
   * is what stops `<w:tr></w:tr>` repeated being free: 300,000 of them occupy
   * memory as retained arrays, contribute zero cells, and would otherwise pass
   * both ceilings and be reported as a clean extraction of an empty table.
   */
  const closeRow = (frame: TableFrame): void => {
    if (frame.cell) closeCell(frame);
    if (frame.row) {
      frame.rows.push(frame.row);
      cells += 1;
    }
    frame.row = null;
  };

  const closeTable = (): void => {
    const frame = open.pop();
    if (frame) closeRow(frame);
  };

  let at = 0;
  while (at < documentXml.length) {
    // Checked once per tag rather than once per cell: the scan is a straight
    // loop, so this is the cheapest place to stop a pathological document.
    if (cells > maxCells) return { kind: 'too-large', reason: 'cells', count: cells };
    if (tables > maxTables) return { kind: 'too-large', reason: 'tables', count: tables };

    const tagStart = documentXml.indexOf('<', at);
    if (tagStart === -1) break;
    const tagEnd = findTagEnd(documentXml, tagStart);
    if (tagEnd === -1) break;

    const raw = documentXml.slice(tagStart + 1, tagEnd);
    at = tagEnd + 1;

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const closing = body.startsWith('/');
    const unclosed = closing ? body.slice(1) : body;
    const name = unclosed.split(/[\s/]/, 1)[0] ?? '';
    const attributes = closing ? '' : unclosed.slice(name.length);

    if (name === TAG_TABLE) {
      if (closing) {
        closeTable();
      } else {
        const frame: TableFrame = { rows: [], row: null, cell: null, carry: new Map(), column: 0 };
        open.push(frame);
        // Recorded on open, not on close, so that a nested table lands after
        // its parent in the results instead of before it - which is also why
        // the frame has to be retained for the whole scan, and why `tables`
        // counts here rather than at the end.
        frames.push(frame);
        tables += 1;
        // `<w:tbl/>` is an empty table: an open immediately followed by its
        // own close. Left open instead, every element after it would be read
        // as being inside a table.
        if (selfClosing) closeTable();
      }
      continue;
    }

    const frame = innermost();
    if (!frame) continue;

    switch (name) {
      case TAG_ROW:
        if (closing) {
          closeRow(frame);
        } else {
          frame.row = [];
          frame.column = 0;
          frame.cell = null;
          // `<w:tr/>` is an empty row, and it has to be recorded as one: left
          // open, the next `<w:tr>` would silently replace it.
          if (selfClosing) closeRow(frame);
        }
        break;

      case TAG_CELL:
        if (closing) {
          closeCell(frame);
        } else {
          frame.cell = { paragraphs: [], open: null, gridSpan: 1, verticalMerge: null };
          // `<w:tc/>` is an empty cell, and it still occupies its column.
          // Dropping it shifts every later cell in the row one place left.
          if (selfClosing) closeCell(frame);
        }
        break;

      case TAG_GRID_SPAN: {
        if (closing || !frame.cell) break;
        const declared = ATTRIBUTE_VALUE.exec(attributes)?.[1] ?? '1';
        const span = Number.parseInt(declared, 10);
        // Clamped, and the clamp is load-bearing rather than tidy. This value
        // is attacker-controlled, nothing else validates it, and it is the
        // bound of the loop that fills the row - so `w:val="99999999999999999999"`
        // threw `RangeError: Invalid array length` out of the pipeline (a 500
        // from a 200-byte upload), and a value just under 2^32 instead spun the
        // event loop allocating an array of that size with both ceilings
        // bypassed, because they are only checked once per tag. Nothing wider
        // than a worksheet can be represented anyway, so that is the clamp.
        if (Number.isFinite(span) && span > 0) {
          frame.cell.gridSpan = Math.min(span, MAX_GRID_SPAN);
        }
        break;
      }

      case TAG_VERTICAL_MERGE: {
        if (closing || !frame.cell) break;
        // A bare `<w:vMerge/>` means "continue the merge above"; the value is
        // only ever `restart` or absent.
        const declared = ATTRIBUTE_VALUE.exec(attributes)?.[1];
        frame.cell.verticalMerge = declared === 'restart' ? 'restart' : 'continue';
        break;
      }

      case TAG_PARAGRAPH: {
        const cell = frame.cell;
        if (!cell) break;
        if (selfClosing) cell.paragraphs.push('');
        else if (closing) {
          cell.paragraphs.push(cell.open ?? '');
          cell.open = null;
        } else cell.open = '';
        break;
      }

      case TAG_TEXT:
        if (closing) {
          if (textStart >= 0 && frame.cell) {
            const characters = documentXml.slice(textStart, tagStart);
            const cell = frame.cell;
            cell.open = (cell.open ?? '') + decodeXmlText(characters);
          }
          textStart = -1;
        } else {
          textStart = at;
        }
        break;

      default:
        break;
    }
  }

  return {
    kind: 'ok',
    tables: frames.filter((frame) => frame.rows.length > 0).map((frame) => frame.rows),
  };
}

/**
 * The index of the `>` that closes the tag opening at `from`.
 *
 * Quote-aware, because an attribute value may contain a `>` - rare in
 * WordprocessingML, but reading one as the end of a tag would desynchronise
 * the whole scan from that point on rather than failing where it happened.
 */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let at = from + 1; at < xml.length; at += 1) {
    const character = xml[at];
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return at;
  }
  return -1;
}

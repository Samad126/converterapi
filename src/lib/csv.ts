/**
 * A small, dependency-free RFC 4180 delimited-text codec - CSV (`,`) and TSV
 * (`\t`) share this one implementation, parameterised on the delimiter,
 * because the two formats differ in nothing else: same quoting rule (a
 * field containing the delimiter, a quote, or a newline is wrapped in `"`,
 * with an embedded `"` doubled), same row/field shape.
 *
 * Hand-rolled rather than a dependency, in keeping with this codebase's own
 * standard for a format small enough to describe correctly in a few dozen
 * lines (see `zip.ts`'s and `archive.engine.ts`'s own comments on the same
 * point) - RFC 4180 quoting is exactly that size, and getting it right by
 * hand once here is cheaper than auditing a third-party parser's behaviour
 * on the same edge cases.
 */

/**
 * Parse delimited text into rows of raw string fields.
 *
 * Deliberately PERMISSIVE, not a strict validator: a stray `"` outside a
 * quoted field is kept literally rather than rejected, `\r\n` and bare `\n`
 * line endings are both accepted, and a missing final line terminator does
 * not drop the last row. Real spreadsheets export CSV in more than one of
 * these shapes, and refusing the ones RFC 4180 does not bless would fail
 * exactly the files people actually have.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyField = false;

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      sawAnyField = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      sawAnyField = true;
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyField = false;
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyField = false;
      i += 1;
      continue;
    }
    field += ch;
    sawAnyField = true;
    i += 1;
  }

  // A trailing row with no line terminator - the common case for a file that
  // was not authored to end with a blank line - still has to be counted.
  if (sawAnyField || field !== '') {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Write rows of raw string fields back out. CRLF between rows, per RFC 4180
 * - the same line ending every mainstream spreadsheet writes.
 */
export function stringifyDelimited(rows: readonly (readonly string[])[], delimiter: string): string {
  const needsQuoting = (field: string): boolean =>
    field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r');
  const quoteField = (field: string): string =>
    needsQuoting(field) ? `"${field.replace(/"/g, '""')}"` : field;

  if (rows.length === 0) return '';
  return rows.map((row) => row.map(quoteField).join(delimiter)).join('\r\n') + '\r\n';
}

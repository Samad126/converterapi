/**
 * Turning the text between two XML tags back into the characters it stands for.
 *
 * A document's own words reach us escaped, and `&amp;` served to a person as
 * "&amp;" is the kind of bug that survives review because the output still
 * looks like a document. Word and LibreOffice escape `&`, `<` and `>` in text,
 * and escape anything outside ASCII as a numeric reference often enough -
 * `caf&#233;` rather than a literal `é` - that leaving them encoded would
 * corrupt ordinary names in half the world's languages.
 *
 * Deliberately not a general-purpose entity table. The five predefined
 * entities plus the numeric forms are the complete set that can appear without
 * a DTD, and a document that declares its own entities is not one we can
 * resolve without a parser - so an unrecognised entity is left as written
 * rather than dropped, which keeps the visible text truthful even when it is
 * not pretty.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Word writes a non-breaking space in table cells that look empty, and
  // leaving it as `&#160;` in a spreadsheet cell is visibly wrong.
  nbsp: ' ',
};

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * The longest entity we will look at, so a stray `&` in a huge document
 * cannot make the scan quadratic.
 */
const MAX_ENTITY_CHARACTERS = 12;

export function decodeXmlText(value: string): string {
  // The overwhelming majority of text has no `&` at all, and this keeps that
  // case from running a regexp over every cell of every table.
  if (!value.includes('&')) return value;

  return value.replace(ENTITY, (whole, body: string) => {
    if (body.length > MAX_ENTITY_CHARACTERS) return whole;

    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointOr(whole, Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return codePointOr(whole, Number.parseInt(body.slice(1), 10));
    }
    return NAMED[body] ?? whole;
  });
}

/**
 * A numeric reference as a character.
 *
 * Rejects the ranges XML forbids outright rather than passing them through:
 * `String.fromCodePoint` throws on surrogates and anything past the last code
 * point, and the C0 controls below `0x20` - other than tab, newline and
 * carriage return - are not legal XML 1.0 characters at all. Emitting one
 * produces a worksheet that is not well-formed, which reads to the user as a
 * workbook that will not open rather than as a control character in a table
 * cell. An illegal reference is left as written, which the writer then escapes,
 * so nothing is silently dropped.
 */
function codePointOr(whole: string, codePoint: number): string {
  if (!Number.isInteger(codePoint)) return whole;
  if (!isLegalXmlCharacter(codePoint)) return whole;
  return String.fromCodePoint(codePoint);
}

/** The Char production of XML 1.0, minus the surrogate block. */
export function isLegalXmlCharacter(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
  if (codePoint < 0x20) return false;
  if (codePoint <= 0xd7ff) return true;
  if (codePoint >= 0xe000 && codePoint <= 0xfffd) return true;
  if (codePoint >= 0x10000 && codePoint <= 0x10ffff) return true;
  return false;
}

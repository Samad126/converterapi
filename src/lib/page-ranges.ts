/**
 * Parsing the page-selection syntax the page endpoints share: `/pdf/remove-
 * pages`, `/pdf/extract-pages` and `/pdf/organize` all take a `pages` (or
 * `order`) field in this format, and all three need the same answer to "is
 * this a real page in this document."
 *
 * The syntax is a comma-separated list of 1-based page numbers and inclusive
 * ranges: `2,5-7,10`. 1-based because that is what a person means by "page 3"
 * - the URL is the only place in this service that counts from zero, and it
 * should stay that way.
 *
 * Order and duplicates in the input are preserved exactly, on purpose: `3,1,2`
 * is a valid reordering, and `1,1` is two copies of page 1. Only the caller
 * (`organize`, which requires a true permutation) decides whether either of
 * those is actually allowed for its own operation - this function only
 * answers "does this name real pages," not "is this the right SHAPE of
 * answer for what you are about to do with it."
 */
import { Errors } from '../errors.ts';

const TOKEN = /^(\d+)(?:-(\d+))?$/;

/**
 * Parse a page selection against a document of `pageCount` pages.
 *
 * Returns 0-based page indices, in the exact order the input named them -
 * `pdf-lib`'s `copyPages` takes indices this way, and it is also the order
 * the output document's pages end up in, which is the entire point of an
 * `order`/`pages` field existing at all.
 *
 * Throws `Errors.badPageRange` (never returns for a bad selection), because
 * every caller needs the same 400 for the same reason: the request named a
 * page that is not a coherent instruction against this specific document.
 */
export function parsePageSelection(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw Errors.badPageRange('No pages were specified.');
  }

  const indices: number[] = [];
  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    const match = TOKEN.exec(token);
    if (!match) {
      throw Errors.badPageRange(
        `"${token}" is not a valid page number or range. Use page numbers and ranges like "2,5-7,10".`,
      );
    }

    const start = Number.parseInt(match[1]!, 10);
    const end = match[2] !== undefined ? Number.parseInt(match[2]!, 10) : start;
    if (end < start) {
      throw Errors.badPageRange(`"${token}" is not a valid range: it goes backwards.`);
    }
    for (let page = start; page <= end; page += 1) {
      if (page < 1 || page > pageCount) {
        throw Errors.badPageRange(
          `Page ${page} does not exist in this ${pageCount}-page document.`,
        );
      }
      indices.push(page - 1);
    }
  }

  return indices;
}

/**
 * Does `indices` (0-based, as `parsePageSelection` returns them) name every
 * page of a `pageCount`-page document exactly once, in some order?
 *
 * This is `organize`'s own extra rule on top of `parsePageSelection`: a
 * reorder must not silently drop or duplicate a page, which is exactly the
 * mistake a typo in the `order` field would otherwise make.
 */
export function isPermutationOfAllPages(indices: readonly number[], pageCount: number): boolean {
  if (indices.length !== pageCount) return false;
  const seen = new Set(indices);
  return seen.size === pageCount;
}

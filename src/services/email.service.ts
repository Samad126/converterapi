/**
 * The `.eml` reader: `mailparser` (already the standard, `nodemailer`-
 * ecosystem tool for this - the same bar `yaml`/`xml-js`/`smol-toml` were
 * held to when they were added), pure JS, no subprocess. `.eml` is RFC 822
 * plain text, so unlike `.msg` (proprietary OLE/MAPI, no legal way to author
 * a real fixture - see `formats.ts`'s own note on why it stays out of this
 * matrix entirely) this is a real, hand-authorable, verified source.
 *
 * Reaches the EXISTING `txt`/`html` target ids through `engineFrom.email` -
 * the same second-route shape a PDF already uses for `docx`/`pptx`/`xlsx`,
 * or the ebook sources use for `epub`. `txt` is the message's own plain-text
 * part if it has one, or `mailparser`'s own HTML-to-text fallback if it only
 * has an HTML part (verified by hand) - either way, real body text, not a
 * dump of MIME boilerplate. `html` is the message's own HTML part, or (a
 * text-only message has none) a minimal wrapper around the plain text so the
 * target still means something. Both are prefixed with a short header block
 * (From/To/Subject/Date) `mailparser` already parsed out, since an email
 * without any indication of who sent it or when is not a faithful rendering
 * of one.
 */
import { simpleParser } from 'mailparser';

import { Errors } from '../errors.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function parseEml(bytes: Buffer): ReturnType<typeof simpleParser> {
  try {
    return await simpleParser(bytes);
  } catch (err) {
    throw Errors.convertFailed(`not a valid email: ${(err as Error).message}`);
  }
}

function headerBlock(parsed: Awaited<ReturnType<typeof simpleParser>>): string[] {
  const lines: string[] = [];
  if (parsed.from?.text) lines.push(`From: ${parsed.from.text}`);
  const to = Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(', ') : parsed.to?.text;
  if (to) lines.push(`To: ${to}`);
  if (parsed.subject) lines.push(`Subject: ${parsed.subject}`);
  if (parsed.date) lines.push(`Date: ${parsed.date.toUTCString()}`);
  return lines;
}

export async function renderEmailAsText(bytes: Buffer): Promise<string> {
  const parsed = await parseEml(bytes);
  const header = headerBlock(parsed);
  const body = parsed.text ?? '(no text content)';
  return [...header, '', body].join('\n');
}

export async function renderEmailAsHtml(bytes: Buffer): Promise<string> {
  const parsed = await parseEml(bytes);
  const header = headerBlock(parsed)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n');
  const body =
    parsed.html !== false && parsed.html
      ? parsed.html
      : `<pre>${escapeHtml(parsed.text ?? '(no text content)')}</pre>`;
  return `<!DOCTYPE html>\n<html><body>\n${header}\n<hr>\n${body}\n</body></html>\n`;
}

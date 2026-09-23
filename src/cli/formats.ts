/**
 * `converter formats` - every source extension this converter reads, and
 * every target it can turn that source into, grouped and printed for a
 * human rather than dumped as a flat id list.
 *
 * Grouped by `DocumentFamily` for the LibreOffice-backed sources (the
 * overwhelming majority of the matrix), with the remaining engine-only
 * sources (PDF, PSD, archives, ebooks, fonts, 3D, data, email, markup) under
 * their own headings, and the audio/video matrix - a completely separate
 * table in `formats-media.ts` - printed last as its own section.
 */
import { ALLOWED_EXTENSIONS, SOURCES, TARGETS, type AllowedExtension, type DocumentFamily } from '../formats.ts';
import { mediaFormat, mediaTargetsFor, MEDIA_TARGET_IDS, type MediaExtension } from '../formats-media.ts';

const color = process.stdout.isTTY;

function c(code: string, text: string): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const bold = (s: string) => c('1', s);
const dim = (s: string) => c('2', s);
const cyan = (s: string) => c('36', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const magenta = (s: string) => c('35', s);

const ARROW = dim('→');

function targetLabels(ids: readonly string[], lookup: (id: string) => string): string {
  return ids.map((id) => green(lookup(id))).join(dim(', '));
}

function printSection(title: string, titleColor: (s: string) => string, rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map(([ext]) => ext.length));
  process.stdout.write(`\n${bold(titleColor(title))}\n`);
  for (const [ext, targets] of rows) {
    process.stdout.write(`  ${cyan(ext.padEnd(width))}  ${ARROW}  ${targets}\n`);
  }
}

const FAMILY_TITLES: Record<DocumentFamily, string> = {
  writer: 'Documents (Writer)',
  calc: 'Spreadsheets (Calc)',
  impress: 'Presentations (Impress)',
  draw: 'Images & Drawings (Draw)',
};

export function printFormats(): void {
  process.stdout.write(`${bold('converter')} — every conversion this tool supports\n`);
  process.stdout.write(dim('One row per source format; targets are what it can become.\n'));

  const byFamily = new Map<DocumentFamily, Array<[string, string]>>();
  const engineRows: Array<[string, string]> = [];

  const sorted = [...ALLOWED_EXTENSIONS].sort((a, b) => a.localeCompare(b));
  for (const ext of sorted as AllowedExtension[]) {
    const source = SOURCES[ext];
    const targets = targetLabels(source.targets, (id) => TARGETS[id as keyof typeof TARGETS].label);
    // `.pdf`'s `family` is `'draw'` - true of how LibreOffice opens it
    // internally (see formats.ts's own comment on `SOURCES['.pdf']`), but not
    // what a reader of this list would expect: a PDF is a document, not an
    // image, and grouping it next to `.png`/`.svg` because of an internal
    // engine detail would be a confusing thing to show someone deciding
    // where to look for it. Displayed under Documents; nothing about how the
    // conversion itself runs changes.
    const displayFamily = ext === '.pdf' ? 'writer' : source.family;
    if (displayFamily) {
      const bucket = byFamily.get(displayFamily) ?? [];
      bucket.push([ext, targets]);
      byFamily.set(displayFamily, bucket);
    } else {
      engineRows.push([ext, targets]);
    }
  }

  for (const family of ['writer', 'calc', 'impress', 'draw'] as DocumentFamily[]) {
    printSection(FAMILY_TITLES[family], yellow, byFamily.get(family) ?? []);
  }
  printSection('Everything else (archives, ebooks, fonts, 3D, data, email, markup, ...)', magenta, engineRows);

  const mediaRows = { audio: [] as Array<[string, string]>, video: [] as Array<[string, string]> };
  const seen = new Set<string>();
  for (const id of MEDIA_TARGET_IDS) {
    const format = mediaFormat(id);
    if (seen.has(format.extension)) continue;
    seen.add(format.extension);
    const targets = mediaTargetsFor(format.extension as MediaExtension)
      .map((t) => green(mediaFormat(t).label))
      .join(dim(', '));
    mediaRows[format.kind].push([format.extension, targets]);
  }
  mediaRows.audio.sort(([a], [b]) => a.localeCompare(b));
  mediaRows.video.sort(([a], [b]) => a.localeCompare(b));
  printSection('Audio', cyan, mediaRows.audio);
  printSection('Video', cyan, mediaRows.video);

  process.stdout.write(
    `\n${dim(`${sorted.length} source formats, ${seen.size} audio/video formats. Run `)}${bold('converter convert <target> <file>')}${dim(' or ')}${bold('converter media <target> <file>')}${dim('.')}\n\n`,
  );
}

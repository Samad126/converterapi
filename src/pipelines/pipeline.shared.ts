/**
 * Shared by every family pipeline in `./families/*.pipeline.ts`: turning a
 * child-process outcome into the right error, and collecting/validating
 * whatever that process wrote to its output directory.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { ClientGoneError, Errors } from '../errors.ts';
import type { ProcessOutcome } from '../engines/soffice.engine.ts';
import type { ProducedFile } from './conversion.pipeline.ts';

/**
 * Turn a killed process into the error the client should see.
 *
 * An assertion rather than a plain check, so that the callers below can go on
 * to read `exitCode` and `stderr` for the failure detail without every one of
 * them re-narrowing the union by hand.
 */
export function throwForOutcome(
  outcome: ProcessOutcome,
): asserts outcome is Extract<ProcessOutcome, { kind: 'exited' }> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
}

/**
 * `throwForOutcome` deliberately does NOT check `exitCode` - because
 * `soffice --convert-to` exits 0 even when it produced nothing (see
 * `conversion.pipeline.ts`'s own header comment), so `runDirectPipeline`/
 * `runEnginePipeline` correctly determine success from whether a file was
 * actually produced, not from the exit code.
 *
 * `pandoc` and `ffmpeg` are not like that: a non-zero exit is a real,
 * meaningful failure for both, and - specifically for ffmpeg - a failed run
 * can still leave a small PARTIAL file behind at the output path (verified
 * by hand: an image over ICO's 256x256 limit leaves a 4-byte stub there
 * even though the encode failed), which `collectProducedFiles` would
 * otherwise happily pick up as "the file was produced" and answer with a
 * corrupt result instead of an error. Called right after `throwForOutcome`
 * by both of those pipelines, never by the soffice-backed ones.
 */
export function throwForNonZeroExit(
  outcome: Extract<ProcessOutcome, { kind: 'exited' }>,
  engineLabel: string,
): void {
  if (outcome.exitCode !== 0) {
    throw Errors.convertFailed(
      `${engineLabel} exited ${outcome.exitCode} (signal=${outcome.signal ?? 'none'}): ` +
        `${outcome.stderr || '(no stderr)'}`,
    );
  }
}

/**
 * Find the files soffice was supposed to write, and insist they are real.
 *
 * The expected name is `input<extension>`, but we fall back to any file with
 * the right extension in the output directory so that a change in LibreOffice's
 * naming - or a document that redirects its own output - degrades into "still
 * works" rather than "mysteriously fails".
 *
 * An empty file is never a success: it is what a failed export leaves behind,
 * and returning it would be a 200 carrying nothing.
 */
export async function collectProducedFiles(outDir: string, extension: string): Promise<ProducedFile[]> {
  const expectedName = `input${extension}`;

  let entries: string[];
  try {
    entries = await fsp.readdir(outDir);
  } catch {
    return []; // The output directory was never created: nothing was produced.
  }

  const matches = entries
    .filter((entry) => entry.toLowerCase().endsWith(extension))
    .sort(byPageNumber);
  // The expected name first, when it exists - it is the one we asked for.
  const ordered = matches.includes(expectedName)
    ? [expectedName, ...matches.filter((entry) => entry !== expectedName)]
    : matches;

  const collected: ProducedFile[] = [];
  for (const entry of ordered) {
    try {
      const stat = await fsp.stat(join(outDir, entry));
      if (!stat.isFile() || stat.size === 0) continue;
      const data = await fsp.readFile(join(outDir, entry));
      if (!looksLike(data, extension)) continue;
      collected.push({ name: entry, data });
    } catch {
      continue;
    }
  }
  return collected;
}

/**
 * A cheap sanity check that the bytes are the type we think they are.
 *
 * Not a validation of the document - just enough to catch the case where an
 * export "succeeded" by writing something that is not the format at all, which
 * would otherwise be served as a 200 with the wrong content type.
 */
function looksLike(data: Buffer, extension: string): boolean {
  if (data.length === 0) return false;
  switch (extension) {
    case '.pdf':
      return data.subarray(0, 5).equals(Buffer.from('%PDF-'));
    case '.png':
      return data
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case '.jpg':
      return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    default:
      return true;
  }
}

/**
 * Order `slide-2.png` before `slide-10.png`.
 *
 * pdftoppm zero-pads consistently within a run, so a plain sort would work
 * today - but it would put page 10 before page 2 the moment that assumption
 * changed, and a deck whose slides are out of order is a silent, annoying bug.
 */
function byPageNumber(a: string, b: string): number {
  const pageOf = (name: string): number => {
    const match = /-(\d+)\.[^.]+$/.exec(name);
    return match ? Number.parseInt(match[1]!, 10) : 0;
  };
  const difference = pageOf(a) - pageOf(b);
  return difference !== 0 ? difference : a.localeCompare(b);
}

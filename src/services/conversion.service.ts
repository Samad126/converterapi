/**
 * One conversion, start to finish: input on disk in, files out.
 *
 * The shape of a request depends on the target:
 *
 *   - `direct` targets are a single `soffice --convert-to` and the file it
 *     writes is the answer.
 *   - `raster` targets (PNG/JPG) are a presentation rendered to PDF and then
 *     split into one image per page, because LibreOffice's own command-line
 *     image export only ever writes the first page. That is two processes, and
 *     they share one deadline: what is being rationed is the client's patience,
 *     not any one process's runtime.
 *
 * Nothing here knows about HTTP. Errors come out as AppError and the caller
 * decides how they are delivered.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { CONVERT_TIMEOUT_MS, MAX_RASTER_PAGES, RASTER_DPI, RASTER_JPEG_QUALITY } from '../config.ts';
import { ClientGoneError, Errors } from '../errors.ts';
import { pdfFilterFor, type DocumentFamily, type ResolvedConversion, type TargetFormat } from '../formats.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { rasterizePdf, runSoffice, type ProcessOutcome } from './soffice.service.ts';
import { OUTPUT_DIRNAME, inputFileNameFor, PROFILE_DIRNAME } from './workspace.service.ts';

/** The images subdirectory, kept apart so collection is "everything in here". */
const RASTER_DIRNAME = 'raster';
/** pdftoppm writes `<prefix>-<page><ext>`. */
const RASTER_PREFIX = 'slide';

export interface ProducedFile {
  /** Suggested filename for the person receiving it. */
  name: string;
  data: Buffer;
}

export interface ConversionResult {
  files: ProducedFile[];
  /**
   * Should the response be a ZIP of `files` rather than one of them?
   *
   * True for every raster target, even a one-slide deck: a client should not
   * have to inspect the content type to find out whether it got an image or an
   * archive, so the answer must not depend on how many slides the upload had.
   */
  archive: boolean;
  /** Wall-clock duration of the whole pipeline, for logging. */
  durationMs: number;
}

export interface ConvertOptions {
  workspace: string;
  /** Already resolved and validated against the matrix by the caller. */
  conversion: ResolvedConversion;
  signal?: AbortSignal;
}

export async function convert(options: ConvertOptions): Promise<ConversionResult> {
  const { workspace, conversion, signal } = options;
  const { source, target } = conversion;

  const inputPath = join(workspace, inputFileNameFor(source.extension));
  const outDir = join(workspace, OUTPUT_DIRNAME);
  const profileDir = join(workspace, PROFILE_DIRNAME);
  const deadline = Date.now() + CONVERT_TIMEOUT_MS;

  if (signal?.aborted) throw signal.reason ?? new ClientGoneError();

  // Fail fast, and with a message that actually helps, when the document is
  // password protected. Left to itself soffice reports this the same way it
  // reports a corrupt file, which would tell the user their document is
  // damaged when in fact it just needs a password.
  if (await isPasswordProtected(inputPath)) {
    throw Errors.encrypted();
  }

  await fsp.mkdir(outDir, { recursive: true });

  const startedAt = Date.now();
  const files =
    target.mode === 'raster'
      ? await runRasterPipeline({
          inputPath,
          outDir,
          workspace,
          profileDir,
          target,
          family: source.family,
          deadline,
          signal,
        })
      : await runDirectPipeline({
          inputPath,
          outDir,
          workspace,
          profileDir,
          target,
          convertTo: conversion.convertTo,
          deadline,
          signal,
        });

  return { files, archive: target.mode === 'raster', durationMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// direct: one soffice run, one answer
// ---------------------------------------------------------------------------

async function runDirectPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  profileDir: string;
  target: TargetFormat;
  convertTo: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, profileDir, target, convertTo, deadline, signal } = run;

  const outcome = await runSoffice({
    inputPath,
    outDir,
    profileDir,
    workspace,
    convertTo,
    deadline,
    signal,
  });
  throwForOutcome(outcome);

  // --convert-to exits 0 even when it produced nothing at all, so the exit code
  // carries no information about success. The only trustworthy signal is the
  // file itself. (Verified: a corrupt .docx gives
  // "Error: source file could not be loaded" and exit status 0.)
  const produced = await collectProducedFiles(outDir, target.extension);
  if (produced.length === 0) {
    throw Errors.convertFailed(
      `soffice produced no ${target.extension} file (exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  // A direct export always writes exactly one file. Naming it after what it is
  // rather than after soffice's internal `input` basename means the download
  // prompt says "converted.xlsx" instead of "input.xlsx".
  if (produced.length === 1) {
    return [{ name: `converted${target.extension}`, data: produced[0]!.data }];
  }
  return produced;
}

// ---------------------------------------------------------------------------
// raster: pdf first, then one image per page
// ---------------------------------------------------------------------------

async function runRasterPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  profileDir: string;
  target: TargetFormat;
  family: DocumentFamily;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, profileDir, target, family, deadline, signal } = run;

  const pdfFilter = pdfFilterFor(family);
  if (!pdfFilter) {
    // Unreachable via the matrix, which refuses to advertise a raster target
    // for a family with no PDF export. Guarded anyway: the alternative is
    // handing soffice an `undefined` filter argument.
    throw Errors.internal(`no PDF export filter for family ${family}`);
  }

  const render = await runSoffice({
    inputPath,
    outDir,
    profileDir,
    workspace,
    convertTo: `pdf:${pdfFilter}`,
    deadline,
    signal,
  });
  throwForOutcome(render);

  const pdf = await collectProducedFiles(outDir, '.pdf');
  const intermediate = pdf[0];
  if (!intermediate) {
    throw Errors.convertFailed(
      `soffice produced no intermediate PDF (exit=${render.exitCode} signal=${render.signal ?? 'none'} stderr=${render.stderr})`,
    );
  }

  // A private directory for the images, so "everything in here" is exactly the
  // pages and can be collected without filtering by filename.
  const rasterDir = join(workspace, RASTER_DIRNAME);
  await fsp.mkdir(rasterDir, { recursive: true });

  const format = target.id === 'png' ? 'png' : 'jpg';
  const raster = await rasterizePdf({
    pdfPath: join(outDir, intermediate.name),
    outDir: rasterDir,
    prefix: RASTER_PREFIX,
    format,
    dpi: RASTER_DPI,
    jpegQuality: RASTER_JPEG_QUALITY,
    workspace,
    deadline,
    signal,
  });
  throwForOutcome(raster);

  const pages = await collectProducedFiles(rasterDir, target.extension);
  if (pages.length === 0) {
    throw Errors.convertFailed(
      `rasteriser produced no images (exit=${raster.exitCode} signal=${raster.signal ?? 'none'} stderr=${raster.stderr})`,
    );
  }
  // Checked before the archive is built, because the archive is built in
  // memory: see MAX_RASTER_PAGES.
  if (pages.length > MAX_RASTER_PAGES) {
    throw Errors.tooLarge(
      `document produced ${pages.length} pages, over the ${MAX_RASTER_PAGES} page limit for image export`,
    );
  }

  return pages.map((page, index) => ({
    // Numbered from the sort order rather than from the filename, so the
    // archive runs 1..N whatever pdftoppm decided to call the files.
    name: `${RASTER_PREFIX}-${index + 1}${target.extension}`,
    data: page.data,
  }));
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Turn a killed process into the error the client should see.
 *
 * An assertion rather than a plain check, so that the callers below can go on
 * to read `exitCode` and `stderr` for the failure detail without every one of
 * them re-narrowing the union by hand.
 */
function throwForOutcome(
  outcome: ProcessOutcome,
): asserts outcome is Extract<ProcessOutcome, { kind: 'exited' }> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
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
async function collectProducedFiles(outDir: string, extension: string): Promise<ProducedFile[]> {
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

/**
 * One conversion, start to finish: input on disk in, files out.
 *
 * The shape of a request depends on the resolved conversion:
 *
 *   - A `viaEngine` pair (today: a PDF asking for `docx`/`pptx`/`xlsx`) is
 *     handed to `pdf_engine.py`, a second, non-LibreOffice conversion engine,
 *     checked BEFORE the target's own `mode` - see `ResolvedConversion.
 *     viaEngine`. It exists because LibreOffice opens every PDF as a Draw
 *     document, and Draw has no Writer/Calc/Impress export filter to reach
 *     any of those three, so there is no `soffice --convert-to` this could
 *     ever be.
 *   - `direct` targets are a single `soffice --convert-to` and the file it
 *     writes is the answer.
 *   - `raster` targets (PNG/JPG) are a presentation rendered to PDF and then
 *     split into one image per page, because LibreOffice's own command-line
 *     image export only ever writes the first page. That is two processes, and
 *     they share one deadline: what is being rationed is the client's patience,
 *     not any one process's runtime. A PDF source skips the render step - it
 *     already is the PDF the other sources have to be turned into - and goes
 *     straight to the split.
 *   - `extract` targets never reach LibreOffice at all. The upload is opened as
 *     the ZIP of XML parts it is and the answer is built from its contents -
 *     which today means one worksheet per table in a Word document, or one PNG
 *     per layer of a PSD.
 *
 * Nothing here knows about HTTP. Errors come out as AppError and the caller
 * decides how they are delivered.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import {
  CONVERT_TIMEOUT_MS,
  MAX_DOCUMENT_XML_BYTES,
  MAX_LAYER_OUTPUT_BYTES,
  MAX_PSD_DECODE_BYTES,
  MAX_PSD_LAYERS,
  MAX_RASTER_PAGES,
  MAX_TABLES,
  MAX_TABLE_CELLS,
  RASTER_DPI,
  RASTER_JPEG_QUALITY,
} from '../config.ts';
import { ClientGoneError, Errors } from '../errors.ts';
import {
  archivesFiles,
  pdfFilterFor,
  type ResolvedConversion,
  type TargetFormat,
  type TargetId,
} from '../formats.ts';
import { extractTables } from '../lib/docx-tables.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { extractLayers, MANIFEST_FILENAME, manifestJson } from '../lib/psd-layers.ts';
import { readZipEntry } from '../lib/unzip.ts';
import { buildXlsx, sheetNameFor, WorkbookLimitError, type XlsxSheet } from '../lib/xlsx.ts';
import { PANDOC_WRITERS, runPandoc } from './pandoc.service.ts';
import {
  PDF_ENGINE_NO_TABLES_EXIT_CODE,
  runPdfEngine,
  type PdfEngineOperation,
} from './pdf-engine.service.ts';
import { rasterizePdf, runSoffice, type ProcessOutcome } from './soffice.service.ts';
import { OUTPUT_DIRNAME, inputFileNameFor, PROFILE_DIRNAME } from './workspace.service.ts';

/** The images subdirectory, kept apart so collection is "everything in here". */
const RASTER_DIRNAME = 'raster';
/** pdftoppm writes `<prefix>-<page><ext>`. */
const RASTER_PREFIX = 'slide';

/**
 * What the layer extractor is allowed to spend, gathered in one place.
 *
 * The defaults live in `config.ts` with the reasoning for each figure; this is
 * only the wiring, so that the three bounds that have to agree about one
 * request are read together rather than scattered through the pipeline.
 */
const LAYER_LIMITS = {
  maxDecodeBytes: MAX_PSD_DECODE_BYTES,
  maxOutputBytes: MAX_LAYER_OUTPUT_BYTES,
  maxLayers: MAX_PSD_LAYERS,
};

/**
 * The one part of a Word package the table extractor reads.
 *
 * Not `document.xml.rels`, not the styles, not the headers: tables live in the
 * body, and reading one named part is what keeps this from being a document
 * model. The cost is that a table in a header, a footer or a footnote is not
 * found - which is a real limitation, and the reason it is stated here rather
 * than left to be discovered.
 */
const DOCUMENT_PART = 'word/document.xml';

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
  /**
   * A PDF asking for `docx`: OCR a scanned source before reconstructing it.
   * Defaults to true. Ignored by every other pair - see `PdfEngineRun.ocr`.
   */
  ocr?: boolean;
}

export async function convert(options: ConvertOptions): Promise<ConversionResult> {
  const { workspace, conversion, signal, ocr } = options;
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
  const files = await (async () => {
    switch (conversion.engine) {
      case 'pdf-engine':
        return runEnginePipeline({ inputPath, outDir, workspace, target, signal, deadline, ocr });
      case 'pandoc':
        return runPandocPipeline({ inputPath, outDir, workspace, target, signal, deadline });
      case 'extract':
        return runExtractPipeline({ inputPath, target, signal, deadline });
      case 'soffice':
        return target.mode === 'raster'
          ? runRasterPipeline({
              inputPath,
              outDir,
              workspace,
              profileDir,
              target,
              // The source is already a PDF, so the "render to PDF first" half of
              // this pipeline is not just unnecessary but wrong to run: soffice
              // would reopen it as a Draw document and re-export it, spending a
              // whole process on a lossy round-trip of bytes we already have.
              sourceIsPdf: source.extension === '.pdf',
              // Resolved here, from the family, rather than passed as a family for
              // the raster pipeline to look up. A source that reaches this branch
              // is one the matrix says has a PDF export, and turning that into the
              // filter string once means the pipeline below cannot be handed a
              // family it has no filter for - which is the only way it could ever
              // have failed.
              pdfFilter: pdfFilterFor(source.family) ?? '',
              deadline,
              signal,
            })
          : runDirectPipeline({
              inputPath,
              outDir,
              workspace,
              profileDir,
              target,
              convertTo: conversion.convertTo,
              deadline,
              signal,
            });
    }
  })();

  // Does the response carry a ZIP? Ask the matrix rather than restating the
  // rule here, because `GET /formats` tells the client the same thing and the
  // two answers have to agree. See `archivesFiles`.
  return { files, archive: archivesFiles(target), durationMs: Date.now() - startedAt };
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
  /** Is the upload already a PDF? Skips the render-to-PDF step below. */
  sourceIsPdf: boolean;
  /** The family's PDF export filter, resolved by the caller. */
  pdfFilter: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, profileDir, target, sourceIsPdf, pdfFilter, deadline, signal } =
    run;

  let intermediatePdfPath: string;
  if (sourceIsPdf) {
    // The upload already is the PDF this pipeline would otherwise spend a
    // soffice process rendering. Handing it straight to the rasteriser skips
    // a lossy round-trip through Draw for no benefit - the bytes on disk are
    // exactly what a PDF-to-image conversion should render.
    intermediatePdfPath = inputPath;
  } else {
    if (pdfFilter === '') {
      // Unreachable via the matrix, which refuses to advertise a raster target
      // for a source with no PDF export. Guarded anyway: the alternative is
      // handing soffice an empty filter argument and getting back whatever it
      // decides that means.
      throw Errors.internal(`no PDF export filter for the ${target.id} target`);
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
    intermediatePdfPath = join(outDir, intermediate.name);
  }

  // A private directory for the images, so "everything in here" is exactly the
  // pages and can be collected without filtering by filename.
  const rasterDir = join(workspace, RASTER_DIRNAME);
  await fsp.mkdir(rasterDir, { recursive: true });

  const format = target.id === 'png' ? 'png' : 'jpg';
  const raster = await rasterizePdf({
    pdfPath: intermediatePdfPath,
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
// extract: read the upload's own package, with no LibreOffice involved
// ---------------------------------------------------------------------------

/**
 * Build the answer out of the document's contents rather than converting it.
 *
 * There is no child process here and no deadline that could be enforced, and
 * that is a deliberate trade rather than an oversight. Everything below runs
 * in-process and, once the bytes are in hand, synchronously: a scan of a
 * bounded document cannot be interrupted halfway through, so a deadline would
 * only ever be consulted after the work it was meant to bound. What bounds it
 * instead is the input - MAX_DOCUMENT_XML_BYTES before the inflate, and
 * MAX_TABLE_CELLS during the scan - and the abort signal, which is honoured at
 * the two points where honouring it is possible.
 *
 * The cost of doing this in-process rather than in a child is that the scan
 * occupies the event loop, where soffice does not. That is why the caps are
 * where they are: a document at the limit is a fraction of a second, and a
 * document past it is refused rather than merely slow.
 */
async function runExtractPipeline(run: {
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
  /** Not enforced by the extractors; see above for why it is passed anyway. */
  deadline: number;
}): Promise<ProducedFile[]> {
  const { inputPath, target, signal } = run;

  // One entry per extract target, and the guard is the point of the table: a
  // target whose engine nobody wired up has to be a loud failure rather than a
  // silent run of some other extractor on a document it was never meant to see.
  // `test/unit.test.ts` checks the table covers every extract target the matrix
  // declares, so the failure lands at build time rather than on a request.
  const extractor = EXTRACTORS[target.id];
  if (!extractor) {
    throw Errors.internal(`no extractor for the ${target.id} target`);
  }
  if (signal?.aborted) throw new ClientGoneError();

  const archive = await fsp.readFile(inputPath);
  return extractor({ archive, inputPath, target, signal });
}

type Extractor = (run: {
  /** The whole upload, in memory. */
  archive: Buffer;
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
}) => Promise<ProducedFile[]>;

/**
 * The extract targets, and the code that answers each of them.
 *
 * `Partial` and not `Record`, deliberately: the compiler cannot then be fooled
 * into thinking the table is complete, the lookup above keeps its runtime
 * guard, and the completeness is asserted by a test instead - where a missing
 * entry is a failed build rather than a 500 in production.
 */
const EXTRACTORS: Partial<Record<TargetId, Extractor>> = {
  tables: extractTablesToWorkbook,
  layers: extractLayersToArchive,
};

/**
 * Test seam: the extract targets that have an engine.
 *
 * Exported so `test/unit.test.ts` can hold the table above to the matrix. The
 * type is `Partial` precisely so the compiler does not demand completeness, so
 * something else has to - and a test is the right place for it, because the
 * alternative is finding out on the first request that asks.
 */
export const EXTRACT_TARGET_IDS = Object.keys(EXTRACTORS) as TargetId[];

/**
 * Every table in a Word document, as one worksheet each.
 *
 * The original extract pipeline, unchanged: read `word/document.xml` out of the
 * upload's own package, scan it for tables, and write a workbook. Nothing here
 * reaches LibreOffice, which is what makes a `.docx` reach a target the
 * conversion matrix could not otherwise offer it.
 */
async function extractTablesToWorkbook(run: {
  archive: Buffer;
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { archive, inputPath, target, signal } = run;
  const part = readZipEntry(archive, DOCUMENT_PART, MAX_DOCUMENT_XML_BYTES);

  if (part.kind === 'too-large') {
    throw Errors.tooLarge(
      `${DOCUMENT_PART} declares ${part.declaredBytes} bytes, over the ${MAX_DOCUMENT_XML_BYTES} byte ceiling`,
    );
  }
  if (part.kind === 'missing') {
    // Not a ZIP at all, or a ZIP without a document part. Either way the
    // upload is not the .docx its extension claims - which is E_CONVERT_FAILED
    // and deliberately not E_NO_TABLES, because there is nothing to say about
    // tables until we can read the document they would be in.
    throw Errors.convertFailed(`${inputPath} has no readable ${DOCUMENT_PART}`);
  }

  const extraction = extractTables(part.data.toString('utf8'), MAX_TABLE_CELLS, MAX_TABLES);
  if (extraction.kind === 'too-large') {
    throw Errors.tooLarge(
      extraction.reason === 'cells'
        ? `document holds more than ${MAX_TABLE_CELLS} table cells`
        : `document holds more than ${MAX_TABLES} tables`,
    );
  }
  if (extraction.tables.length === 0) {
    // Not a failure of ours and not a damaged document: it simply has no
    // tables, and saying so is the whole of the useful answer.
    throw Errors.noTables();
  }

  const takenNames = new Set<string>();
  const sheets: XlsxSheet[] = extraction.tables.map((rows, index) => ({
    name: sheetNameFor(index + 1, takenNames),
    rows,
  }));

  let workbook: Buffer;
  try {
    workbook = buildXlsx(sheets);
  } catch (error) {
    if (error instanceof WorkbookLimitError) {
      // Excel refuses the whole workbook over a limit, so an oversized cell or
      // a worksheet too tall or wide to represent would otherwise produce a
      // file the user cannot open - or, worse, one silently missing the end of
      // a table. Refusing says so instead.
      throw Errors.tooLarge(error.message);
    }
    throw error;
  }

  // The last point at which an abort can still change the outcome. Everything
  // between the read and here was synchronous, so a client that left during it
  // could not be noticed until now - and if it did leave, the workbook is
  // still worth having built: it costs nothing to discard, and the alternative
  // is a check that cannot be placed anywhere more useful.
  if (signal?.aborted) throw new ClientGoneError();

  return [{ name: `converted${target.extension}`, data: workbook }];
}

/**
 * Every layer of a Photoshop document, as its own PNG, in one archive.
 *
 * The second engine that reaches no LibreOffice, and a different shape of
 * answer from the first: `tables` puts however many tables a document holds
 * into one workbook, while this returns one file per layer plus a manifest -
 * which is why its target declares `multiple` and `tables` does not.
 *
 * The `name` on each produced file is the archive entry name rather than a
 * download filename: `Buttons/Hover.png` is where the layers panel put it, and
 * nesting is how the document's own grouping survives the trip. `manifest.json`
 * sits alongside them and describes every layer, including the ones that
 * produced no file and why.
 *
 * Everything expensive here already happened in `extractLayers`, which is
 * synchronous and cannot be interrupted part-way. The abort checks below are
 * therefore only about the work still to come, and there is exactly one piece
 * of it - assembling the manifest - so this is the honest place for the last
 * one, not a deadline that would be consulted after the fact.
 */
async function extractLayersToArchive(run: {
  archive: Buffer;
  target: TargetFormat;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { archive, target, signal } = run;

  const extraction = extractLayers(archive, LAYER_LIMITS, signal);

  switch (extraction.kind) {
    case 'too-large':
      throw Errors.tooLarge(extraction.reason);
    case 'no-layers':
      // The layer-shaped twin of E_NO_TABLES: the document opened and was read,
      // and simply holds nothing this service can draw.
      throw Errors.noLayers();
    case 'unreadable':
      // Not a PSD, or not one we can read. E_CONVERT_FAILED for the same reason
      // the tables path uses it for a .docx that is not a ZIP: there is nothing
      // to say about a document's layers until the document can be read.
      throw Errors.convertFailed(`could not read ${target.id} from the upload: ${extraction.reason}`);
    case 'cancelled':
      throw new ClientGoneError();
    case 'ok':
      break;
  }

  if (signal?.aborted) throw new ClientGoneError();

  return [
    ...extraction.layers.map((layer) => ({ name: layer.file, data: layer.data })),
    { name: MANIFEST_FILENAME, data: manifestJson(extraction.manifest) },
  ];
}

// ---------------------------------------------------------------------------
// engine: a PDF asking for docx/pptx/xlsx, answered by pdf_engine.py
// ---------------------------------------------------------------------------

/**
 * Run `pdf_engine.py` for a `viaEngine` pair - today, only a PDF asking for
 * `docx`, `pptx` or `xlsx`.
 *
 * The target's own id doubles as the operation name: `PdfEngineOperation` is
 * exactly `'docx' | 'pptx' | 'xlsx'`, which is exactly the three ids
 * `engineFrom` ever appears on, so there is nothing else to look up. Shaped
 * like `runDirectPipeline` - write to `outDir`, respect the deadline and the
 * abort signal, insist the output is really there - because the failure modes
 * are the same failure modes: a wedged process, a client that left, an empty
 * file left behind by a crash.
 */
async function runEnginePipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
  ocr?: boolean;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, target, deadline, signal, ocr } = run;
  const operation = target.id as PdfEngineOperation;

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);

  const outcome = await runPdfEngine({
    operation,
    inputPath,
    outputPath,
    workspace,
    deadline,
    signal,
    ocr,
  });

  if (outcome.kind === 'exited' && outcome.exitCode === PDF_ENGINE_NO_TABLES_EXIT_CODE) {
    // Only the xlsx operation uses this exit code (see pdf_engine.py); docx
    // and pptx never produce it, since there is no "this PDF has no
    // paragraphs" or "no pages" equivalent worth a dedicated error.
    throw Errors.noTables();
  }
  throwForOutcome(outcome);

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `pdf_engine.py ${operation} produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

// ---------------------------------------------------------------------------
// engine: a markup source (.md/.rst/.tex/...) asking for docx/html/odt/rtf/
// txt/markdown, answered by pandoc
// ---------------------------------------------------------------------------

/**
 * Run pandoc for a source `formats.ts` names under `target.engineFrom.pandoc`.
 *
 * Shaped like `runEnginePipeline`: one process, one output file expected in
 * `outDir`, the same deadline/abort-signal handling every pipeline here uses.
 * `target.id` cannot double as the pandoc writer name the way it does for
 * `PdfEngineOperation` - pandoc's own writer for the `markdown` target is
 * `gfm`, not `markdown` - so `PANDOC_WRITERS` looks it up instead.
 */
async function runPandocPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, target, deadline, signal } = run;
  const writer = PANDOC_WRITERS[target.id];
  if (!writer) {
    // Unreachable as the matrix stands - every target `engineFrom.pandoc`
    // names has an entry in `PANDOC_WRITERS` - but a target added to one
    // without the other should fail loudly here rather than call pandoc
    // with `undefined` as its `-t` argument.
    throw Errors.convertFailed(`no pandoc writer registered for target "${target.id}"`);
  }

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);

  const outcome = await runPandoc({ inputPath, outputPath, writer, workspace, deadline, signal });
  throwForOutcome(outcome);

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `pandoc -t ${writer} produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
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

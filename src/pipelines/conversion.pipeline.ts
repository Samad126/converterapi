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
 *
 * The pipeline for each `conversion.engine` value lives in its own module
 * under `./families/`, named after the engine it drives; this file only
 * resolves which one a request needs and calls it. Helpers shared by more
 * than one family (`throwForOutcome`, `collectProducedFiles`, ...) live in
 * `./pipeline.shared.ts`.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { CONVERT_TIMEOUT_MS } from '../config.ts';
import { ClientGoneError, Errors } from '../errors.ts';
import { archivesFiles, pdfFilterFor, type ResolvedConversion } from '../formats.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { OUTPUT_DIRNAME, inputFileNameFor, PROFILE_DIRNAME } from '../services/workspace.service.ts';

import { runArchivePipeline } from './families/archive.pipeline.ts';
import { runAssimpPipeline } from './families/assimp.pipeline.ts';
import { runDataPipeline } from './families/data.pipeline.ts';
import { runDirectPipeline } from './families/direct.pipeline.ts';
import { runEbookPipeline } from './families/ebook.pipeline.ts';
import { runEmailPipeline } from './families/email.pipeline.ts';
import { runEnginePipeline } from './families/engine.pipeline.ts';
import { runExtractPipeline } from './families/extract.pipeline.ts';
import { runFfmpegPipeline } from './families/ffmpeg.pipeline.ts';
import { runFontPipeline } from './families/font.pipeline.ts';
import { runHeifPipeline } from './families/heif.pipeline.ts';
import { runPandocPipeline } from './families/pandoc.pipeline.ts';
import { runRasterPipeline } from './families/raster.pipeline.ts';

export { EXTRACT_TARGET_IDS } from './families/extract.pipeline.ts';

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
      case 'data':
        return runDataPipeline({
          inputPath,
          sourceExtension: source.extension,
          target,
          workspace,
          deadline,
          signal,
        });
      case 'archive':
        return runArchivePipeline({
          inputPath,
          outDir,
          workspace,
          sourceExtension: source.extension,
          target,
          signal,
          deadline,
        });
      case 'ffmpeg':
        return runFfmpegPipeline({ inputPath, outDir, workspace, target, signal, deadline });
      case 'heif':
        return runHeifPipeline({
          inputPath,
          outDir,
          workspace,
          sourceExtension: source.extension,
          target,
          signal,
          deadline,
        });
      case 'assimp':
        return runAssimpPipeline({ inputPath, outDir, workspace, target, signal, deadline });
      case 'ebook':
        return runEbookPipeline({ inputPath, outDir, workspace, target, signal, deadline });
      case 'font':
        return runFontPipeline({ inputPath, outDir, workspace, target, signal, deadline });
      case 'email':
        return runEmailPipeline({ inputPath, target, signal });
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

/**
 * Reading engine output back off disk, validating uploads, and writing the
 * HTTP response for `pages.controller.ts`. Split out of the controller
 * because these are pure input/output functions with no dependency on the
 * controller's `deps` closure.
 */
import fsp from 'node:fs/promises';
import type { Response } from 'express';

import { MAX_PAGE_OPERATION_TOTAL_BYTES } from '../config.ts';
import { AppError, ClientGoneError, Errors } from '../errors.ts';
import { contentDispositionFor } from '../lib/download-name.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { zipStored } from '../lib/zip.ts';
import type { ProcessOutcome } from '../engines/soffice.engine.ts';

export interface PagesResult {
  /** One entry, or several when `archive` is true. */
  files: Array<{ name: string; data: Buffer }>;
  archive: boolean;
  downloadName: string;
}

/**
 * Turn a `pdf_engine.py` run that produces a PDF (`ocr`, `redact`) into
 * either the bytes it produced or the right AppError - the `pdf_engine.py`
 * twin of `readQpdfOutput` below, for the page-operation endpoints that go
 * through the Python engine rather than qpdf or pdf-lib.
 */
export async function readPdfEngineOutput(
  outcome: ProcessOutcome,
  outputPath: string,
): Promise<Buffer> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  if (outcome.kind === 'exited' && (outcome.exitCode ?? -1) !== 0) {
    throw Errors.convertFailed(outcome.stderr || `pdf_engine.py exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath);
    if (data.length === 0) throw new Error('pdf_engine.py produced an empty file');
    return data;
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

/**
 * Turn a `pdf_engine.py` `compare` run into the parsed JSON report it wrote,
 * or the right AppError. Unlike every PDF-producing outcome in this file,
 * an empty output is not itself suspicious to check for - a valid, empty-ish
 * JSON body is small but never zero bytes - so this only has to distinguish
 * "the process didn't finish" from "the process wrote something that isn't
 * the JSON it promised".
 */
export async function readPdfCompareOutput(
  outcome: ProcessOutcome,
  outputPath: string,
): Promise<unknown> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  if (outcome.kind === 'exited' && (outcome.exitCode ?? -1) !== 0) {
    throw Errors.convertFailed(outcome.stderr || `pdf_engine.py exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

/**
 * Turn a qpdf run into either the bytes it produced or the right AppError.
 *
 * qpdf writes nothing and exits non-zero on failure, so success is "exit 0
 * (or exit 3, for `/pdf/repair` - see below) and a file appeared" - the same
 * "exit code alone carries no information" caution `soffice.engine.ts`
 * documents for LibreOffice, checked the same way: look at what actually
 * landed on disk.
 */
export async function readQpdfOutput(
  outcome: ProcessOutcome,
  outputPath: string,
  options: { wrongPasswordAware?: boolean; warningsAreSuccess?: boolean } = {},
): Promise<Buffer> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  // qpdf's own exit codes: 0 clean, 3 "warnings only" (the file was still
  // written), 2 a real error. `/pdf/repair` exists specifically for files
  // that trigger warnings - a damaged PDF that qpdf could only PARTIALLY
  // recover is exactly the case this endpoint is for, so exit 3 there is the
  // expected outcome, not a failure.
  const acceptable = options.warningsAreSuccess ? [0, 3] : [0];
  if (outcome.kind === 'exited' && !acceptable.includes(outcome.exitCode ?? -1)) {
    if (options.wrongPasswordAware && /invalid password/i.test(outcome.stderr)) {
      throw Errors.wrongPassword();
    }
    throw Errors.convertFailed(outcome.stderr || `qpdf exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath);
    if (data.length === 0) throw new Error('qpdf produced an empty file');
    return data;
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

/**
 * Checks every handler needs before touching pdf-lib: nothing is empty, the
 * combined size is within budget, and (unless told to skip - scan-to-PDF's
 * images are not PDFs) nothing is password protected.
 */
export async function assertUploadsUsable(
  files: readonly Express.Multer.File[],
  options: { skipEncryptionCheck?: boolean } = {},
): Promise<void> {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_PAGE_OPERATION_TOTAL_BYTES) {
    throw Errors.tooLarge(`combined upload of ${totalBytes} bytes exceeds the per-request limit`);
  }
  for (const file of files) {
    if (file.size === 0) {
      throw Errors.convertFailed(`${file.path} was empty`);
    }
    if (!options.skipEncryptionCheck && (await isPasswordProtected(file.path))) {
      throw Errors.encrypted();
    }
  }
}

/** Send a `PagesResult` the same way `convert.controller.ts` sends a conversion's. */
export function sendPagesResult(res: Response, result: PagesResult): void {
  if (result.archive) {
    const archive = zipStored(result.files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDispositionFor(result.downloadName));
    res.setHeader('Content-Length', String(archive.length));
    res.status(200).end(archive);
    return;
  }

  const file = result.files[0];
  if (!file) throw new AppError('E_INTERNAL', 500, 'Something went wrong on the server.');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDispositionFor(result.downloadName));
  res.setHeader('Content-Length', String(file.data.length));
  res.status(200).end(file.data);
}

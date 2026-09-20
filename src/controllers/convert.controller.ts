/**
 * The conversion endpoint, as HTTP.
 *
 * This layer does three things and nothing else: validate that the request is
 * asking for something the matrix supports, hand the work to the conversion
 * service, and turn the result into a response. The LibreOffice knowledge lives
 * in services/, and what formats exist lives in formats.ts.
 *
 * The ordering of the middleware below is deliberate and is about not doing
 * expensive work for a request that is going to be refused:
 *
 *   admit            rate limit and capacity, before a single byte is read
 *   validateTarget   resolves /convert/<target>, before the body is read
 *   prepareWorkspace so the upload streams straight into the directory it will
 *                    be converted in and cleaned up with
 *   upload           the body itself
 *   handle           the conversion
 *
 * ONE file under `files`, or SEVERAL - the request shape is identical, always
 * that one field name, and `handle` decides what a response looks like only
 * once it knows the count: exactly one file gets the plain response `/convert`
 * has always given (the bare converted file, or its own archive for a raster
 * target), so nothing about today's callers has to change to keep working
 * unconverted through this file's own rename from "the single-file path" to
 * "the one-file case of the general path". Two or more get one ZIP holding
 * every result, because there is no other honest way to answer "convert these
 * N files" with N independent outcomes in one HTTP response.
 */
import fsp from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';

import {
  TARGET_IDS,
  isTargetId,
  resolveConversion,
  targetsFor,
  type ResolvedConversion,
  type TargetId,
} from '../formats.ts';
import { MAX_CONVERT_TOTAL_BYTES } from '../config.ts';
import { AppError, ClientGoneError, Errors } from '../errors.ts';
import { contentDispositionFor, downloadNameFor } from '../lib/download-name.ts';
import { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import { zipStored, type ZipEntry } from '../lib/zip.ts';
import { convert, type ConversionResult } from '../services/conversion.service.ts';
import { createWorkspace } from '../services/workspace.service.ts';
import { cleanup, getContext, logRequest, type RequestContext } from '../middleware/request-context.ts';

export interface ConvertControllerDeps {
  queue: BoundedQueue;
  rateLimiter: RateLimiter;
}

export interface ConvertController {
  admit: (req: Request, _res: Response, next: NextFunction) => void;
  validateTarget: (req: Request, _res: Response, next: NextFunction) => void;
  prepareWorkspace: (req: Request, _res: Response, next: NextFunction) => void;
  handle: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

export function createConvertController(deps: ConvertControllerDeps): ConvertController {
  const { queue, rateLimiter } = deps;

  const admit: ConvertController['admit'] = (req, _res, next) => {
    if (!rateLimiter.check(req.ip ?? 'unknown')) {
      next(Errors.rateLimited());
      return;
    }
    // Refuse before the client uploads 25MB we have nowhere to put. The
    // authoritative check is still the queue's own acquire().
    if (!queue.hasCapacity()) {
      next(Errors.busy());
      return;
    }
    next();
  };

  const validateTarget: ConvertController['validateTarget'] = (req, _res, next) => {
    // The route is `/convert/:target`, so there is no absent case to default -
    // a request that does not name a target never reaches this handler.
    const segment = req.params.target;
    const requested = typeof segment === 'string' ? segment : '';
    if (!isTargetId(requested)) {
      // A target id that does not exist is a 404: there is no such address.
      // Distinct from a real target this source cannot become, which is a 415
      // raised once we know what the source is.
      next(Errors.unknownTarget(TARGET_IDS));
      return;
    }
    getContext(req).target = requested;
    next();
  };

  const prepareWorkspace: ConvertController['prepareWorkspace'] = (req, _res, next) => {
    createWorkspace()
      .then((workspace) => {
        getContext(req).workspace = workspace;
        next();
      })
      .catch(next);
  };

  /**
   * One file's conversion, shared by both the single- and multi-file paths
   * below. Throws an `AppError` on any failure - empty upload, a target this
   * source cannot reach, or whatever `convert()` itself throws - and leaves
   * it to the caller to decide whether that ends the request (one file) or is
   * recorded alongside other files' successes (several).
   */
  async function convertOne(
    meta: NonNullable<RequestContext['bulkFiles']>[number],
    upload: Express.Multer.File | undefined,
    targetId: TargetId,
    ocr: boolean,
    signal: AbortSignal,
  ): Promise<{ conversion: ResolvedConversion; result: ConversionResult }> {
    // A zero-byte upload is not a document, but LibreOffice cheerfully opens
    // it as an empty one and exports a perfectly valid blank document - which
    // would be a success carrying a file the user never had. Reject it here,
    // where we still know it was empty.
    if (!upload || upload.size === 0) {
      throw Errors.convertFailed('uploaded file was empty');
    }
    const conversion = resolveConversion(meta.extension, targetId);
    if (!conversion) {
      // A real target, but not one this document can become. Tell the person
      // what they CAN have instead.
      throw Errors.unsupportedTarget(meta.extension, targetsFor(meta.extension));
    }
    const result = await queue.run(signal, () =>
      convert({ workspace: meta.dir, conversion, signal, ocr }),
    );
    return { conversion, result };
  }

  const handle: ConvertController['handle'] = async (req, res, next) => {
    const ctx = getContext(req);
    const uploads = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
    ctx.bytes = uploads.reduce((total, file) => total + file.size, 0);

    try {
      const targetId = ctx.target as TargetId | undefined;
      if (!targetId) throw Errors.internal('target was not resolved before the upload');

      const files = ctx.bulkFiles ?? [];
      if (files.length === 0) {
        throw Errors.badRequest('no files under "files"');
      }
      // Only worth checking once there is more than one file: a single file
      // is already bounded by MAX_UPLOAD_BYTES, which this would just repeat.
      if (files.length > 1 && ctx.bytes > MAX_CONVERT_TOTAL_BYTES) {
        throw Errors.tooLarge(`combined upload of ${ctx.bytes} bytes exceeds the per-request limit`);
      }

      // For `logRequest`, which reads `ctx.extension` for the single-file
      // shape every log line predates this endpoint's multi-file form, and
      // falls back to a count when there is no one extension to name.
      if (files.length === 1) {
        ctx.extension = files[0]!.extension;
      } else {
        ctx.operation = `convert×${files.length}`;
      }

      const ocr = parseOcrFlag(req.body?.ocr);

      if (files.length === 1) {
        const meta = files[0]!;
        const { conversion, result } = await convertOne(
          meta,
          uploads[0],
          targetId,
          ocr,
          ctx.controller.signal,
        );

        if (res.writableEnded || ctx.controller.signal.aborted) {
          // The client left while we were working. There is nobody to answer.
          logRequest(ctx, 'client_gone');
          return;
        }

        // The output is in memory now, so the input, the LibreOffice profile
        // and any copy of the output on disk are all dead weight. Drop them
        // before writing the response, so the space is reclaimed the moment
        // the client has its file rather than a few milliseconds later.
        await cleanup(ctx);

        // The download keeps the upload's name, with the target's extension.
        // Note that the original filename is read HERE and nowhere else: it
        // is never used as a path, and it is never logged.
        const downloadName = downloadNameFor(
          meta.originalName,
          result.archive ? '.zip' : conversion.target.extension,
        );
        sendResult(res, result, conversion.target.mediaType, downloadName);
        logRequest(ctx, 'ok', { status: 200 });
        return;
      }

      // Two or more files: convert each independently, and answer with one
      // ZIP holding every result. One file's failure - wrong type for this
      // target, a damaged document - does not abort the rest: the caller
      // asked to convert N files, and a partial answer ("here are the M that
      // worked, and why the rest did not", recorded as an `errors.json` entry
      // in the same archive) is more useful than losing all M to report on
      // one.
      const entries: ZipEntry[] = [];
      const errors: Array<{ file: string; code: string; message: string }> = [];

      for (let index = 0; index < files.length; index += 1) {
        const meta = files[index]!;
        const label = meta.originalName || `file ${index + 1}`;
        const prefix = String(index + 1).padStart(2, '0');

        try {
          const { conversion, result } = await convertOne(
            meta,
            uploads[index],
            targetId,
            ocr,
            ctx.controller.signal,
          );

          if (result.archive) {
            // This file's own output is itself several files (a raster
            // target) - keep them together under a folder named after it
            // rather than flattening everything into one directory, where
            // "slide-1.png" from two different source decks would collide.
            const folder = `${prefix}-${downloadNameFor(meta.originalName, '')}`;
            for (const inner of result.files) {
              entries.push({ name: `${folder}/${inner.name}`, data: inner.data });
            }
          } else {
            const file = result.files[0];
            if (!file) throw new AppError('E_INTERNAL', 500, 'Something went wrong on the server.');
            const name = downloadNameFor(meta.originalName, conversion.target.extension);
            entries.push({ name: `${prefix}-${name}`, data: file.data });
          }
        } catch (error) {
          if (error instanceof ClientGoneError) throw error;
          const appError = error instanceof AppError ? error : Errors.internal(error);
          errors.push({ file: label, code: appError.code, message: appError.userMessage });
        } finally {
          // Each file's own subdirectory (input, LibreOffice profile, output)
          // is dead weight the moment it is either archived above or
          // recorded as a failure - freed here rather than waiting for the
          // whole batch's cleanup so a large batch does not hold every
          // file's temp files on disk at once.
          await fsp.rm(meta.dir, { recursive: true, force: true }).catch(() => {});
        }

        if (res.writableEnded || ctx.controller.signal.aborted) {
          logRequest(ctx, 'client_gone');
          return;
        }
      }

      if (errors.length > 0) {
        entries.push({
          name: 'errors.json',
          data: Buffer.from(JSON.stringify(errors, null, 2)),
        });
      }

      await cleanup(ctx);

      const archive = zipStored(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', contentDispositionFor('converted-files.zip'));
      res.setHeader('Content-Length', String(archive.length));
      res.status(200).end(archive);
      logRequest(ctx, 'ok', { status: 200 });
    } catch (error) {
      if (error instanceof ClientGoneError) {
        // Not an error and not a response: the client is gone, so this is the
        // only place it can be recorded.
        logRequest(ctx, 'client_gone');
        return;
      }
      // Handed to the error handler, which is the single place a failed request
      // is logged. Logging here as well - which this used to do - produced two
      // identical lines for every failure.
      next(error);
    } finally {
      // Every remaining path: conversion failure, timeout, bad request.
      // Idempotent, so the success path above having already cleaned up is
      // fine. `res.on('close')` is the third net, for the paths where this
      // handler never ran at all because multer rejected the upload.
      await cleanup(ctx);
    }
  };

  return { admit, validateTarget, prepareWorkspace, handle };
}

/**
 * The optional `ocr` form field: whether a PDF with no extractable text (a
 * scan) asking for `docx` should be OCR'd before reconstruction. Defaults to
 * true, and is silently ignored by every other source/target pair - see
 * `PdfEngineRun.ocr` for why accepting it universally, rather than only for
 * `.pdf -> docx`, costs nothing and avoids a special case here. One value for
 * the whole request, single file or several: it is a request-level choice,
 * not a per-file one.
 */
function parseOcrFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw !== 'string') {
    throw Errors.invalidField('The "ocr" field must be "true" or "false".');
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw Errors.invalidField('The "ocr" field must be "true" or "false".');
}

/**
 * Turn a single file's conversion result into the whole response body - the
 * one-file case of `handle`.
 *
 * A raster target is always an archive, even for a single slide, so that the
 * content type does not depend on how many slides the upload happened to have.
 * A client that has to sniff whether it got an image or a zip has a bug waiting
 * for it on the one-slide deck.
 */
function sendResult(
  res: Response,
  result: { files: Array<{ name: string; data: Buffer }>; archive: boolean },
  mediaType: string,
  downloadName: string,
): void {
  if (result.archive) {
    // The entry names inside the archive come from the conversion service -
    // `slide-1.png`, `slide-2.png` - because those describe the pages. The
    // archive's own name is the download name, derived from the upload.
    const archive = zipStored(result.files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDispositionFor(downloadName));
    res.setHeader('Content-Length', String(archive.length));
    res.status(200).end(archive);
    return;
  }

  const file = result.files[0];
  if (!file) throw new AppError('E_INTERNAL', 500, 'Something went wrong on the server.');

  // Exactly the target's media type, and for PDF exactly `application/pdf`
  // with no charset suffix: the client inspects this header and refuses
  // anything that does not match.
  res.setHeader('Content-Type', mediaType);
  res.setHeader('Content-Disposition', contentDispositionFor(downloadName));
  res.setHeader('Content-Length', String(file.data.length));
  res.status(200).end(file.data);
}

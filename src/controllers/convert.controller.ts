/**
 * The conversion endpoints, as HTTP.
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
 */
import type { NextFunction, Request, Response } from 'express';

import {
  TARGET_IDS,
  isTargetId,
  resolveConversion,
  targetsFor,
  type TargetId,
} from '../formats.ts';
import { AppError, ClientGoneError, Errors } from '../errors.ts';
import { contentDispositionFor, downloadNameFor } from '../lib/download-name.ts';
import { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import { zipStored } from '../lib/zip.ts';
import { convert } from '../services/conversion.service.ts';
import { createWorkspace } from '../services/workspace.service.ts';
import { cleanup, getContext, logRequest } from '../middleware/request-context.ts';

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

  const handle: ConvertController['handle'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    try {
      const targetId = ctx.target as TargetId | undefined;
      if (!targetId) throw Errors.internal('target was not resolved before the upload');

      if (!req.file) {
        throw Errors.badRequest('no file part named "file"');
      }
      const extension = ctx.extension;
      if (!extension) {
        throw Errors.unsupported();
      }
      // A zero-byte upload is not a document, but LibreOffice cheerfully opens
      // it as an empty one and exports a perfectly valid blank document - which
      // would be a 200 carrying a file the user never had. Reject it here,
      // where we still know it was empty.
      if (req.file.size === 0) {
        throw Errors.convertFailed('uploaded file was empty');
      }

      const conversion = resolveConversion(extension, targetId);
      if (!conversion) {
        // A real target, but not one this document can become. Tell the person
        // what they CAN have instead.
        throw Errors.unsupportedTarget(extension, targetsFor(extension));
      }

      const ocr = parseOcrFlag(req.body?.ocr);

      const result = await queue.run(ctx.controller.signal, () =>
        convert({
          workspace: ctx.workspace!,
          conversion,
          signal: ctx.controller.signal,
          ocr,
        }),
      );

      if (res.writableEnded || ctx.controller.signal.aborted) {
        // The client left while we were working. There is nobody to answer.
        logRequest(ctx, 'client_gone');
        return;
      }

      // The output is in memory now, so the input, the LibreOffice profile and
      // any copy of the output on disk are all dead weight. Drop them before
      // writing the response, so the space is reclaimed the moment the client
      // has its file rather than a few milliseconds later.
      await cleanup(ctx);

      // The download keeps the upload's name, with the target's extension. Note
      // that the original filename is read HERE and nowhere else: it is never
      // used as a path, and it is never logged.
      const downloadName = downloadNameFor(
        req.file.originalname ?? '',
        result.archive ? '.zip' : conversion.target.extension,
      );
      sendResult(res, result, conversion.target.mediaType, downloadName);
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
 * `.pdf -> docx`, costs nothing and avoids a special case here.
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
 * Turn the service's output into a response body.
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

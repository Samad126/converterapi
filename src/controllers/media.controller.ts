/**
 * `POST /media/{target}` and its job endpoints, as HTTP - the asynchronous
 * twin of `convert.controller.ts`.
 *
 * `POST /convert/{target}` answers within one request because that request
 * is a bounded amount of work; a real audio/video transcode is not, so this
 * endpoint answers `202` with a job id the moment the upload is accepted and
 * VALIDATED, and the actual conversion keeps running after the response has
 * gone out. A client polls `GET /media/jobs/{id}` for status and
 * `GET /media/jobs/{id}/download` once it says `done`.
 *
 * The upload's workspace deliberately does NOT live on `ctx.workspace` the
 * way every other endpoint's does. `requestContext()` removes `ctx.workspace`
 * unconditionally the moment `res` finishes (see that file's own comment) -
 * exactly right for a synchronous endpoint, and exactly wrong here, since the
 * conversion this request kicks off is still running long after its own
 * response has been sent. The job's workspace is tracked on `res.locals`
 * instead (see `media-upload.ts`), which nothing but this file and the job
 * store ever reads.
 */
import { extname } from 'node:path';

import type { NextFunction, Request, Response } from 'express';

import { AppError, Errors } from '../errors.ts';
import {
  isMediaTargetId,
  mediaFormat,
  mediaTargetsFor,
  resolveMediaConversion,
  type MediaExtension,
  type MediaTargetId,
} from '../formats-media.ts';
import { contentDispositionFor, downloadNameFor } from '../lib/download-name.ts';
import type { RateLimiter } from '../lib/queue.ts';
import {
  createMediaJob,
  createMediaWorkspace,
  getMediaJob,
  mediaQueueHasCapacity,
  startMediaJob,
  type MediaJob,
} from '../jobs/media-jobs.service.ts';
import { removeWorkspace } from '../services/workspace.service.ts';
import type { MediaUploadLocals } from '../middleware/media-upload.ts';

export interface MediaControllerDeps {
  rateLimiter: RateLimiter;
}

export interface MediaController {
  admit: (req: Request, res: Response, next: NextFunction) => void;
  validateTarget: (req: Request, res: Response, next: NextFunction) => void;
  prepareWorkspace: (req: Request, res: Response, next: NextFunction) => void;
  cleanupOnError: (error: unknown, req: Request, res: Response, next: NextFunction) => void;
  handle: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  status: (req: Request, res: Response) => void;
  download: (req: Request, res: Response) => void;
}

export function createMediaController(deps: MediaControllerDeps): MediaController {
  const { rateLimiter } = deps;

  const admit: MediaController['admit'] = (req, _res, next) => {
    if (!rateLimiter.check(req.ip ?? 'unknown')) {
      next(Errors.rateLimited());
      return;
    }
    // Refuse before the client uploads up to MEDIA_MAX_UPLOAD_BYTES we have
    // nowhere to put. The authoritative check is still the queue's own
    // acquire() inside startMediaJob, exactly as it is for /convert.
    if (!mediaQueueHasCapacity()) {
      next(Errors.busy());
      return;
    }
    next();
  };

  const validateTarget: MediaController['validateTarget'] = (req, res, next) => {
    const segment = req.params.target;
    const requested = typeof segment === 'string' ? segment : '';
    if (!isMediaTargetId(requested)) {
      next(
        new AppError(
          'E_UNKNOWN_TARGET',
          404,
          'That is not an audio/video format this converter can produce.',
        ),
      );
      return;
    }
    (res.locals as Partial<MediaUploadLocals> & { mediaTarget?: MediaTargetId }).mediaTarget =
      requested;
    next();
  };

  const prepareWorkspace: MediaController['prepareWorkspace'] = (_req, res, next) => {
    createMediaWorkspace()
      .then((workspace) => {
        (res.locals as Partial<MediaUploadLocals>).mediaWorkspace = workspace;
        next();
      })
      .catch(next);
  };

  // A dedicated error middleware for this router ONLY, ahead of the shared
  // one: the shared `errorHandler` cleans up `ctx.workspace`, which this
  // endpoint deliberately never sets (see this file's own header comment).
  // Anything that fails between `prepareWorkspace` creating the directory
  // and `handle` handing it to a job (a rejected extension, an oversized
  // upload, an unsupported target for this source) would otherwise leak it
  // forever - nothing else in the request pipeline knows this path exists.
  // A job that HAS been created and started is the one case this must NOT
  // touch: `next(error)` for that case never happens, because `handle`
  // itself does not throw once `startMediaJob` has been called.
  const cleanupOnError: MediaController['cleanupOnError'] = (error, _req, res, next) => {
    const workspace = (res.locals as Partial<MediaUploadLocals>).mediaWorkspace;
    if (workspace) {
      (res.locals as Partial<MediaUploadLocals>).mediaWorkspace = undefined;
      void removeWorkspace(workspace).catch(() => {});
    }
    next(error);
  };

  const handle: MediaController['handle'] = async (req, res, next) => {
    try {
      const locals = res.locals as Partial<MediaUploadLocals> & { mediaTarget?: MediaTargetId };
      const targetId = locals.mediaTarget;
      const workspace = locals.mediaWorkspace;
      if (!targetId || !workspace) {
        throw Errors.internal('media target or workspace missing before upload');
      }

      const uploads = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const upload = uploads[0];
      if (!upload) {
        throw Errors.badRequest('no file under "files"');
      }
      if (upload.size === 0) {
        throw Errors.convertFailed('uploaded file was empty');
      }

      // Re-derive with the same `extname()` every other upload path uses,
      // rather than trust multer's own field: `media-upload.ts`'s
      // `fileFilter` already proved this is a `MediaExtension`, and this
      // cast documents that rather than re-deriving the check.
      const sourceExtension = extname(upload.originalname ?? '').toLowerCase() as MediaExtension;

      const target = resolveMediaConversion(sourceExtension, targetId);
      if (!target) {
        throw new AppError(
          'E_UNSUPPORTED_TARGET',
          415,
          `A ${sourceExtension} file can be converted to: ` +
            `${mediaTargetsFor(sourceExtension).map((id) => mediaFormat(id).label).join(', ')}.`,
        );
      }

      const downloadName = downloadNameFor(upload.originalname, target.extension);
      const job: MediaJob = createMediaJob({
        sourceExtension,
        target: targetId,
        workspace,
        downloadName,
      });

      // Fire-and-forget, by design: the whole point of this endpoint is that
      // the response below does not wait for this to finish.
      startMediaJob(job);

      res.setHeader('Content-Type', 'application/json');
      res.status(202).end(
        JSON.stringify({
          id: job.id,
          status: job.status,
          statusUrl: `/media/jobs/${job.id}`,
        }),
      );
    } catch (error) {
      next(error);
    }
  };

  const status: MediaController['status'] = (req, res) => {
    const idParam = req.params.id;
    const job = getMediaJob(typeof idParam === 'string' ? idParam : '');
    if (!job) {
      const error = Errors.jobNotFound();
      res.setHeader('Content-Type', 'application/json');
      res.status(error.status).end(JSON.stringify(error.toEnvelope()));
      return;
    }

    const body: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      target: job.target,
    };
    if (job.status === 'done') {
      body.downloadUrl = `/media/jobs/${job.id}/download`;
      body.bytes = job.bytes;
    }
    if (job.status === 'failed' && job.error) {
      body.error = job.error;
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify(body));
  };

  const download: MediaController['download'] = (req, res) => {
    const idParam = req.params.id;
    const job = getMediaJob(typeof idParam === 'string' ? idParam : '');
    if (!job) {
      const error = Errors.jobNotFound();
      res.setHeader('Content-Type', 'application/json');
      res.status(error.status).end(JSON.stringify(error.toEnvelope()));
      return;
    }
    if (job.status === 'queued' || job.status === 'running') {
      const error = Errors.jobNotReady(job.status);
      res.setHeader('Content-Type', 'application/json');
      res.status(error.status).end(JSON.stringify(error.toEnvelope()));
      return;
    }
    if (job.status === 'failed') {
      res.setHeader('Content-Type', 'application/json');
      res
        .status(job.errorStatus ?? 500)
        .end(JSON.stringify({ error: job.error ?? Errors.internal().toEnvelope().error }));
      return;
    }

    // job.status === 'done'
    if (!job.resultPath) {
      const error = Errors.internal('job marked done with no result path');
      res.setHeader('Content-Type', 'application/json');
      res.status(error.status).end(JSON.stringify(error.toEnvelope()));
      return;
    }

    res.setHeader('Content-Type', mediaFormat(job.target).mediaType);
    res.setHeader('Content-Disposition', contentDispositionFor(job.downloadName));
    res.sendFile(job.resultPath, (error) => {
      if (error && !res.headersSent) {
        const appError = Errors.internal(error);
        res.setHeader('Content-Type', 'application/json');
        res.status(appError.status).end(JSON.stringify(appError.toEnvelope()));
      }
    });
  };

  return { admit, validateTarget, prepareWorkspace, cleanupOnError, handle, status, download };
}

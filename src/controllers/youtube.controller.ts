/**
 * `POST /youtube/{target}` - the YouTube twin of `POST /media/{target}`.
 *
 * Same contract on purpose: it answers `202` with a job id the moment the link
 * is validated, and the job is then polled and downloaded through the SAME
 * `/media/jobs/{id}` endpoints an upload's job uses. That is one job store
 * behind one set of routes, so a client that already handles a media job
 * handles this one with no new code - and both kinds share the one
 * `MAX_CONCURRENT_MEDIA_JOBS` pool, which is the right limit, since both are
 * heavy and long-running.
 *
 * The request is JSON, not multipart, because it carries a link rather than a
 * file. Only `url` is read from the body; anything else in it is ignored.
 */
import type { NextFunction, Request, Response } from 'express';

import { AppError, Errors } from '../errors.ts';
import {
  createYouTubeJob,
  createMediaWorkspace,
  startMediaJob,
} from '../jobs/media-jobs.service.ts';
import { isYouTubeTargetId, parseYouTubeUrl, type YouTubeTargetId } from '../lib/youtube-url.ts';
import { createMediaController, type MediaControllerDeps } from './media.controller.ts';

export interface YouTubeController {
  admit: (req: Request, res: Response, next: NextFunction) => void;
  validateTarget: (req: Request, res: Response, next: NextFunction) => void;
  bodyError: (error: unknown, req: Request, res: Response, next: NextFunction) => void;
  handle: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

/** Said whenever the body is missing, not JSON, or not an object - so the person knows the shape. */
const BODY_HELP = 'Send the link as JSON, like {"url": "https://www.youtube.com/watch?v=..."}.';

export function createYouTubeController(deps: MediaControllerDeps): YouTubeController {
  // The same admission control as `POST /media/{target}` - the rate limit and
  // the queue's capacity - because a YouTube job takes the same queue slot.
  const { admit } = createMediaController(deps);

  const validateTarget: YouTubeController['validateTarget'] = (req, res, next) => {
    const segment = typeof req.params.target === 'string' ? req.params.target : '';
    if (!isYouTubeTargetId(segment)) {
      next(
        new AppError(
          'E_UNKNOWN_TARGET',
          404,
          'YouTube videos can only be converted to MP4 or MP3.',
        ),
      );
      return;
    }
    (res.locals as { youtubeTarget?: YouTubeTargetId }).youtubeTarget = segment;
    next();
  };

  // A body the JSON parser rejected (malformed, or over its size limit) would
  // otherwise reach the shared handler as a generic 500 or a "document too
  // large" sentence. Both are wrong for a link, so they become one clear
  // sentence about the request shape.
  const bodyError: YouTubeController['bodyError'] = (error, _req, _res, next) => {
    const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
    if (typeof type === 'string' && type.startsWith('entity.')) {
      next(Errors.invalidField(BODY_HELP));
      return;
    }
    next(error);
  };

  const handle: YouTubeController['handle'] = async (req, res, next) => {
    try {
      const targetId = (res.locals as { youtubeTarget?: YouTubeTargetId }).youtubeTarget;
      if (!targetId) {
        throw Errors.internal('youtube target missing before the handler');
      }

      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null) {
        throw Errors.invalidField(BODY_HELP);
      }
      const rawUrl = (body as { url?: unknown }).url;
      const video = typeof rawUrl === 'string' ? parseYouTubeUrl(rawUrl) : null;
      if (!video) {
        throw Errors.invalidField('That is not a YouTube video link.');
      }

      const workspace = await createMediaWorkspace();
      const job = createYouTubeJob({
        videoId: video.videoId,
        url: video.canonicalUrl,
        target: targetId,
        workspace,
      });

      // Fire-and-forget, the same as `POST /media/{target}`: the response does
      // not wait for the download, which can run for minutes.
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

  return { admit, validateTarget, bodyError, handle };
}

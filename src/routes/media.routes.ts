/**
 * The audio/video job routes - Phase 5, deliberately separate from
 * `/convert/{target}`'s synchronous contract. See `media.controller.ts`'s
 * own header comment for why.
 *
 *   POST /media/{target}          -> 202, { id, status, statusUrl }
 *   GET  /media/jobs/{id}         -> job status, and a downloadUrl once done
 *   GET  /media/jobs/{id}/download -> the converted file, once done
 */
import { Router } from 'express';

import { createMediaController, type MediaControllerDeps } from '../controllers/media.controller.ts';
import { createMediaUploadMiddleware } from '../middleware/media-upload.ts';

export function createMediaRouter(deps: MediaControllerDeps): Router {
  const router = Router();
  const controller = createMediaController(deps);
  const upload = createMediaUploadMiddleware();

  router.post(
    '/media/:target',
    controller.admit,
    controller.validateTarget,
    controller.prepareWorkspace,
    upload,
    controller.handle,
    controller.cleanupOnError,
  );

  router.get('/media/jobs/:id', controller.status);
  router.get('/media/jobs/:id/download', controller.download);

  return router;
}

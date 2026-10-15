/**
 * The YouTube route - `POST /youtube/{target}`, which answers `202` with a job
 * id. Its status and download are the shared `/media/jobs/{id}` routes in
 * `media.routes.ts`, so this router only adds the one endpoint.
 *
 * Mounted with its own `json()` parser rather than globally: no other route
 * takes JSON, and a global parser would be a limit every multipart upload
 * also had to pass through. The 4kb cap is for a URL and nothing else.
 */
import { json, Router } from 'express';

import {
  createYouTubeController,
  type YouTubeController,
} from '../controllers/youtube.controller.ts';
import type { MediaControllerDeps } from '../controllers/media.controller.ts';

export function createYouTubeRouter(deps: MediaControllerDeps): Router {
  const router = Router();
  const controller: YouTubeController = createYouTubeController(deps);

  router.post(
    '/youtube/:target',
    controller.admit,
    controller.validateTarget,
    json({ limit: '4kb' }),
    controller.bodyError,
    controller.handle,
  );

  return router;
}

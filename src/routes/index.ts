/**
 * Every route this service serves.
 *
 * The order matters only in that the conversion router must come before the
 * catch-all 404 that the app mounts afterwards; Express matches in the order
 * things are registered.
 */
import { Router } from 'express';

import { ENABLE_DOCS } from '../config.ts';
import type { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import { mediaQueueStats } from '../jobs/media-jobs.service.ts';
import { createConvertRouter } from './convert.routes.ts';
import { createDocsRouter } from './docs.routes.ts';
import { createFormatsRouter } from './formats.routes.ts';
import { createHealthRouter } from './health.routes.ts';
import { createMediaRouter } from './media.routes.ts';
import { createPagesRouter } from './pages.routes.ts';

export interface RouteDeps {
  queue: BoundedQueue;
  rateLimiter: RateLimiter;
  /** Overridable so tests can assert the docs are actually gone when disabled. */
  enableDocs?: boolean;
}

export function createRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.use(createHealthRouter({ queueStats: () => deps.queue.stats(), mediaQueueStats }));
  router.use(createFormatsRouter());

  if (deps.enableDocs ?? ENABLE_DOCS) {
    router.use(createDocsRouter());
  }

  router.use(createConvertRouter({ queue: deps.queue, rateLimiter: deps.rateLimiter }));
  router.use(createPagesRouter({ queue: deps.queue, rateLimiter: deps.rateLimiter }));
  router.use(createMediaRouter({ rateLimiter: deps.rateLimiter }));

  return router;
}

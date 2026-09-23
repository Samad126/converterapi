/**
 * Liveness.
 *
 * Deliberately trivial, and deliberately not a readiness check: it answers "is
 * this process serving HTTP", which is exactly what a container orchestrator
 * needs to decide whether to restart it. Whether LibreOffice is healthy is
 * settled at boot - the process refuses to start if it is not - so there is
 * nothing useful to re-check here.
 *
 * `status` stays `ok` (and the HTTP status stays 200) purely on reaching this
 * handler, on purpose: `MAX_CONCURRENT_CONVERSIONS` defaults to 2, so a couple
 * of slow conversions saturate the queue during perfectly ordinary load. Tying
 * a 503 to that would teach an orchestrator to restart a server that is simply
 * busy, trading a slow response for a dropped one. `queue`/`mediaQueue` are
 * exposed as DATA instead, so a human or a monitor can see "every slot is
 * full" without the liveness check itself flapping because of it.
 */
import { Router } from 'express';

import type { QueueStats } from '../lib/queue.ts';

export interface HealthRouterDeps {
  /** Stats for the `/convert/{target}` admission queue. */
  queueStats: () => QueueStats;
  /** Stats for the `/media/{target}` admission queue. */
  mediaQueueStats: () => QueueStats;
}

export function createHealthRouter(deps: HealthRouterDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    // We only ever listen after preflight has confirmed the whole pipeline
    // works, so reaching this handler at all is the confirmation.
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(
      JSON.stringify({
        status: 'ok',
        queue: deps.queueStats(),
        mediaQueue: deps.mediaQueueStats(),
      }),
    );
  });

  return router;
}

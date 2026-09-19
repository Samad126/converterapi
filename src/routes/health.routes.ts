/**
 * Liveness.
 *
 * Deliberately trivial, and deliberately not a readiness check: it answers "is
 * this process serving HTTP", which is exactly what a container orchestrator
 * needs to decide whether to restart it. Whether LibreOffice is healthy is
 * settled at boot - the process refuses to start if it is not - so there is
 * nothing useful to re-check here.
 */
import { Router } from 'express';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    // We only ever listen after preflight has confirmed the whole pipeline
    // works, so reaching this handler at all is the confirmation.
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify({ status: 'ok' }));
  });

  return router;
}

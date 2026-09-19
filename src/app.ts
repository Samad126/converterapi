/**
 * The Express application, assembled.
 *
 * Separate from `server.ts` so that tests can build the app without booting a
 * listener, and without preflight - which is a statement about whether THIS
 * MACHINE can produce correct output, while the tests are about the HTTP
 * contract, which holds either way.
 */
import express from 'express';

import { CORS_ORIGIN, MAX_CONCURRENT_CONVERSIONS, MAX_QUEUED_CONVERSIONS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, TRUST_PROXY } from './config.ts';
import { BoundedQueue, RateLimiter } from './lib/queue.ts';
import { cors } from './middleware/cors.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { requestContext } from './middleware/request-context.ts';
import { createRoutes } from './routes/index.ts';

export interface AppOptions {
  queue?: BoundedQueue;
  rateLimiter?: RateLimiter;
  enableDocs?: boolean;
  /** Defaults to CORS_ORIGIN. `''` disables CORS, which is the default there. */
  corsOrigin?: string;
}

export function createApp(options: AppOptions = {}) {
  const queue =
    options.queue ?? new BoundedQueue(MAX_CONCURRENT_CONVERSIONS, MAX_QUEUED_CONVERSIONS);
  const rateLimiter = options.rateLimiter ?? new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  const app = express();
  app.disable('x-powered-by');
  // req.ip is only the client's address if we believe the proxy's forwarding
  // header. Without this, every request behind the reverse proxy shares one rate
  // limit bucket and the limiter is worse than useless.
  app.set('trust proxy', TRUST_PROXY);

  // First, so that every later handler - including the error handler - has a
  // request id, a cancellation signal and a cleanup hook.
  app.use(requestContext());

  // After the request context, so that a preflight and every error response
  // still carry an X-Request-Id, and before the routes, so that a preflight is
  // answered without reaching the rate limiter or a conversion handler.
  app.use(cors(options.corsOrigin ?? CORS_ORIGIN));

  app.use(createRoutes({ queue, rateLimiter, enableDocs: options.enableDocs }));

  // Order matters, and only here: the 404 has to see the requests nothing else
  // matched, and the error handler has to be last so it catches what every
  // layer above it throws.
  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

/**
 * CORS, for the browser client.
 *
 * The policy lives here rather than in the reverse proxy for two reasons:
 *
 *   - this is the only layer that sees EVERY response. Headers set by the
 *     route handlers would miss the catch-all 404, the 400 from a rejected
 *     upload, and everything the error handler produces - which is most of
 *     what a browser actually needs to read;
 *   - it is part of the wire contract, and this repository keeps its contract
 *     where `test/` can assert it - the same argument that keeps the statuses
 *     and messages of `openapi.yaml` pinned by test/openapi.test.ts. A policy
 *     living in a proxy's config is out of reach of the suite, and the 413
 *     below is the standing proof of how easily that goes unnoticed.
 *
 * What it deliberately does NOT cover is the one response this service never
 * sees: nginx refuses an oversized upload with its own 413 before a byte
 * reaches Node, so no code of ours can put a header on it. That single header
 * lives in the nginx site file, and is the only CORS header there.
 *
 * The preflight branch below is required rather than defensive, which is worth
 * stating because the request does not look like one that needs it. The upload
 * sets no request headers at all, and its `multipart/form-data` body would be
 * safelisted on its own - but an XHR carrying an `upload` listener, which is
 * how the frontend drives its progress bar, sets the use-CORS-preflight flag
 * by specification. The browser therefore asks permission before it sends a
 * byte, and an unanswered preflight means the upload never happens.
 *
 * Note what this is not. CORS is a rule BROWSERS enforce on themselves; it is
 * not access control. The Android client sends no `Origin` and is unaffected
 * either way, and anything that can open a socket can simply leave the header
 * off. The rate limiter, not this, is what protects the endpoint.
 */
import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers the browser may hand to JavaScript.
 *
 * Both are read by the frontend and neither is visible without this: response
 * headers are opaque to script by default. A missing entry here costs the user
 * their real filename (`Content-Disposition`) and empties the reference in the
 * error dialog (`X-Request-Id`).
 */
const EXPOSED_HEADERS = 'Content-Disposition, X-Request-Id';

/** What a preflight may ask for. The API converts with POST and reads with GET. */
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * Request headers a preflight may approve.
 *
 * `Content-Type` covers the upload, whose body is `multipart/form-data`. That
 * is a CORS-safelisted value, so the browser need not ask about it - but a
 * preflight that omits a header it WAS asked about fails outright, and listing
 * one extra header here costs nothing.
 */
const ALLOWED_HEADERS = 'Content-Type';

/** How long a browser may cache the preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE = '86400';

/**
 * An empty `allowedOrigin` disables the whole middleware, which is the right
 * default: the Android client needs none of it, and a same-origin frontend
 * needs none either. Only a split frontend/API deployment configures it.
 */
export function cors(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowedOrigin === '') return next();

    // Set on EVERY response, matching or not. The value varies by the
    // request's `Origin`, so a cache that ignores it could hand a matching
    // origin's response to a non-matching one.
    res.vary('Origin');

    // Exact comparison, which is what the browser will do with the result. A
    // prefix or case-insensitive match here would be more permissive than the
    // client's own check and would buy nothing.
    if (req.headers.origin !== allowedOrigin) return next();

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

    // A preflight, and nothing else. Requiring `Access-Control-Request-Method`
    // is what leaves a bare `OPTIONS` alone: it falls through to the router,
    // which answers it with its own 200 and an `Allow` header exactly as it
    // did before this middleware existed. Answering on the method alone would
    // take that over and change the API's behaviour for clients that were
    // never subject to CORS in the first place.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      // Answered before any route and before the rate limiter. A browser sends
      // one preflight per URL and method it has not cached, and charging the
      // user's budget for requests they never made would make the limiter
      // count the wrong thing.
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Per-request state: an id, a cancellation signal, and the workspace.
 *
 * This is the middleware that makes the rest of the service safe to write
 * straightforwardly, because it guarantees two things the routes would
 * otherwise each have to remember:
 *
 *   - a conversion is CANCELLED when the client goes away, so a cancelled
 *     upload does not leave a soffice process burning CPU for 90 seconds on a
 *     machine that is deliberately CPU-capped;
 *   - the workspace is REMOVED on every path, including the ones where the
 *     route handler never ran at all because multer rejected the upload.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { ClientGoneError, type ErrorCode } from '../errors.ts';
import type { AllowedExtension, TargetId } from '../formats.ts';
import { removeWorkspace } from '../services/workspace.service.ts';

export interface RequestContext {
  rid: string;
  startedAt: number;
  /** Set before multer runs; the workspace lives for the whole request. */
  workspace?: string;
  /** Validated from the uploaded part's filename extension. */
  extension?: AllowedExtension;
  /** The target this request asked for, once it is known. */
  target?: TargetId;
  /**
   * A label for a request that is not a `/convert/{target}` conversion - the
   * page endpoints (`merge`, `split`, `remove-pages`, ...) log this in place
   * of `extension`/`target`, which do not describe a multi-file or
   * parameterised request.
   */
  operation?: string;
  bytes?: number;
  /** Tracked by `pages-upload.ts` as each part of a multi-file upload arrives. */
  uploadedFileCount?: number;
  /**
   * One entry per file of a `POST /convert/{target}` request, in upload
   * order - populated by `convert-upload.ts` as each part arrives, whether
   * the request carries one file or several. Each file gets its own
   * subdirectory of `workspace` (`convert()` expects a workspace to itself),
   * which is why a directory rather than just a size is recorded.
   */
  bulkFiles?: Array<{ originalName: string; extension: AllowedExtension; dir: string }>;
  /** Aborted on client disconnect so a running soffice can be killed. */
  controller: AbortController;
  /**
   * The one in-flight removal of `workspace`, once it has been started.
   *
   * See `cleanup` for why this is remembered rather than simply re-run.
   */
  cleanupPromise?: Promise<void>;
}

/**
 * Contexts are keyed by the request object rather than stored on it.
 *
 * A WeakMap rather than `req.ctx` so nothing outside this module can invent or
 * overwrite the state a handler trusts, and so the entry disappears with the
 * request instead of living as long as anything holds a reference to it.
 */
const contexts = new WeakMap<Request, RequestContext>();

/** The context for a request. Throws rather than returning undefined. */
export function getContext(req: Request): RequestContext {
  const ctx = contexts.get(req);
  if (!ctx) {
    // Only reachable if a route is mounted without this middleware, which is a
    // wiring mistake - and one that would otherwise surface as a TypeError
    // somewhere much less obvious.
    throw new Error('request context missing: is requestContext() mounted?');
  }
  return ctx;
}

/** One line per request. Never a filename, never document content. */
export function logRequest(
  ctx: RequestContext,
  outcome: string,
  extra: { status?: number; code?: ErrorCode; detail?: string } = {},
): void {
  const line = {
    rid: ctx.rid,
    outcome,
    // The source extension and the target are not sensitive - they are what the
    // person chose to do - and without them a log line says a request happened
    // but not what it was.
    source: ctx.extension,
    target: ctx.target,
    operation: ctx.operation,
    status: extra.status,
    code: extra.code,
    bytes: ctx.bytes,
    ms: Date.now() - ctx.startedAt,
    detail: extra.detail,
  };
  const text = JSON.stringify(line);
  if (outcome === 'ok' || extra.status === undefined || extra.status < 500) {
    console.log(text);
  } else {
    console.error(text);
  }
}

/**
 * Remove the request's workspace, once, and let every caller wait for it.
 *
 * Called from three places - the success path, the route handler's `finally`,
 * and the error handler - because which of them runs depends on how the request
 * ended. The subtlety is that "idempotent" has to mean MORE than "harmless to
 * call twice": the first caller starts the delete, and the caller that actually
 * writes the response must wait for THAT delete to finish, not for a second
 * call that finds nothing left to do and returns instantly.
 *
 * Returning the in-flight promise is what makes that true. Nulling the
 * workspace and returning immediately instead - which is what this used to do -
 * let the error handler answer the client while the directory was still being
 * deleted, so the disk was reclaimed some milliseconds after the response
 * rather than before it, which is the opposite of the promise being made here.
 */
export function cleanup(ctx: RequestContext): Promise<void> {
  if (ctx.cleanupPromise) return ctx.cleanupPromise;

  const dir = ctx.workspace;
  ctx.workspace = undefined;
  // Never rejects: a workspace we could not delete is a stale-directory problem
  // for the sweeper, not a reason to fail a request that may have succeeded.
  ctx.cleanupPromise = dir ? removeWorkspace(dir).catch(() => {}) : Promise.resolve();
  return ctx.cleanupPromise;
}

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx: RequestContext = {
      rid: randomUUID().slice(0, 8),
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    contexts.set(req, ctx);
    res.setHeader('X-Request-Id', ctx.rid);

    // Cancel the conversion when the client goes away.
    //
    // `req.on('close')` alone is NOT a disconnect signal: it also fires the
    // moment the request body has been fully read, which for a small upload is
    // before the conversion even starts. Guarding on `req.complete` keeps only
    // the genuine case - the body was still arriving when the socket died.
    // `res.on('close')` with `writableFinished` false is the general case: the
    // connection died before we managed to send a complete response.
    const onClientGone = () => {
      if (!ctx.controller.signal.aborted) {
        ctx.controller.abort(new ClientGoneError());
      }
    };
    req.on('close', () => {
      if (!req.complete) onClientGone();
    });
    res.on('close', () => {
      if (!res.writableFinished) onClientGone();
      // Guaranteed cleanup: this runs on every path, including the ones where
      // the handler never executes because multer rejected the upload.
      void cleanup(ctx);
    });

    next();
  };
}

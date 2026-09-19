/**
 * Every remaining response is the JSON envelope.
 *
 * The client checks the status code before it reads anything and refuses any
 * Content-Type that is not exactly what it expects, so a stray HTML error page
 * from Express or multer is a client-visible failure rather than a cosmetic
 * one. Funnelling every error through one place is what makes the contract hold
 * by construction instead of by everyone remembering it.
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { AppError, Errors } from '../errors.ts';
import { cleanup, getContext, logRequest } from './request-context.ts';

/**
 * Write the error envelope.
 *
 * `Content-Type` is exactly `application/json`, with no charset suffix: a
 * strict client may compare the header, and `application/json; charset=utf-8`
 * is not the same string.
 */
export function respondJson(res: Response, error: AppError, status = error.status): void {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(error.toEnvelope()));
}

/**
 * Map anything thrown anywhere into the error contract.
 *
 * multer and body-parser have their own error types and, left alone, they
 * render an HTML error page - which the client would see as "the server is
 * broken" rather than as a sentence it can show the user.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return Errors.tooLarge();
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_PART_COUNT':
        return Errors.badRequest(error.message);
      default:
        return Errors.badRequest(error.message);
    }
  }

  // body-parser (and anything else that speaks this shape) reporting an
  // oversized body. Express's default here is an HTML page.
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { type?: string; status?: number; statusCode?: number };
    if (
      candidate.type === 'entity.too.large' ||
      candidate.status === 413 ||
      candidate.statusCode === 413
    ) {
      return Errors.tooLarge();
    }
  }

  return Errors.internal(error);
}

/**
 * The catch-all 404.
 *
 * A 404 here means the client asked for a path this service does not serve,
 * which in practice means the APK is older than the server. Say something the
 * person holding the phone can act on.
 */
export function notFoundHandler() {
  return (_req: Request, res: Response): void => {
    respondJson(
      res,
      new AppError(
        'E_BAD_REQUEST',
        404,
        'The converter is not available at this address. Please update the app and try again.',
      ),
    );
  };
}

export function errorHandler() {
  return async (error: unknown, req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (res.headersSent) {
      // Nothing useful left to say; let Express close the connection.
      next(error);
      return;
    }

    const appError = toAppError(error);
    let ctx;
    try {
      ctx = getContext(req);
    } catch {
      ctx = undefined;
    }

    if (ctx) {
      // The single log line for a failed request, written where the response is
      // decided. `cause` carries the detail a developer needs - soffice's
      // stderr, say - which is never sent to the client.
      logRequest(ctx, 'error', {
        status: appError.status,
        code: appError.code,
        detail: appError.cause instanceof Error ? appError.cause.message : undefined,
      });
    } else {
      console.error(JSON.stringify({ outcome: 'error', code: appError.code }));
    }

    // Reclaim the disk BEFORE answering, for the same reason the success path
    // does: once the client has the response, its input, LibreOffice profile
    // and output are all dead weight. This is also the only cleanup point that
    // covers errors raised by multer itself, which never reach the route
    // handler - a rejected extension or an oversized upload has already had a
    // workspace created for it by the time the filter runs.
    if (ctx) await cleanup(ctx);

    respondJson(res, appError);
  };
}

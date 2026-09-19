/**
 * HTTP surface.
 *
 * Two endpoints, and a contract with a shipped Android client that constrains
 * almost every decision in here:
 *
 *   - Success is ALWAYS `Content-Type: application/pdf` with the PDF as the
 *     body. The client checks that header and refuses anything else, so a stray
 *     text/html on a 200 is a client-visible failure.
 *   - Failure is ALWAYS a non-2xx with the JSON error envelope. The client
 *     reads `error.message` for its dialog, and falls back to "HTTP <status>"
 *     when the body is missing or is not JSON.
 *   - A failure is NEVER a 200. The client checks the status before it reads
 *     anything, so a 200 is treated as a PDF and fails somewhere far away.
 *
 * The practical consequence: every error path - including the ones Express and
 * multer would normally render as HTML - has to be funnelled through the same
 * JSON envelope.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ENABLE_DOCS,
  HOST,
  MAX_UPLOAD_BYTES,
  MAX_CONCURRENT_CONVERSIONS,
  MAX_QUEUED_CONVERSIONS,
  PORT,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  SKIP_WARMUP,
  SWEEP_INTERVAL_MS,
  TRUST_PROXY,
  isAllowedExtension,
  type AllowedExtension,
} from './config.ts';
import {
  DOCS_CONTENT_SECURITY_POLICY,
  loadOpenApiDocument,
  swaggerUiHtml,
} from './openapi.ts';
import {
  convertToPdf,
  createWorkspace,
  inputFileNameFor,
  preflight,
  removeWorkspace,
  sweepStaleWorkspaces,
  warmUp,
} from './convert.ts';
import { AppError, ClientGoneError, Errors, PreflightError, type ErrorCode } from './errors.ts';
import { BoundedQueue, RateLimiter } from './queue.ts';

interface RequestContext {
  rid: string;
  startedAt: number;
  /** Set before multer runs; the workspace lives for the whole request. */
  workspace?: string;
  /** Validated from the uploaded part's filename extension. */
  extension?: AllowedExtension;
  bytes?: number;
  /** Aborted on client disconnect so a running soffice can be killed. */
  controller: AbortController;
}

const contexts = new WeakMap<Request, RequestContext>();

/** One line per request. Never a filename, never document content. */
function logRequest(
  ctx: RequestContext,
  outcome: string,
  extra: { status?: number; code?: ErrorCode; detail?: string } = {},
): void {
  const line = {
    rid: ctx.rid,
    outcome,
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
 * Write the error envelope.
 *
 * The one place that turns an AppError into a response, so the contract holds
 * by construction rather than by everyone remembering it: `Content-Type` is
 * exactly `application/json` (no charset suffix, because a strict client may
 * compare the header) and the body is always the envelope.
 */
function respondJson(res: Response, error: AppError, status = error.status): void {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(error.toEnvelope()));
}

export interface AppOptions {
  queue?: BoundedQueue;
  rateLimiter?: RateLimiter;
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

  // --- Per-request context, cancellation and cleanup ------------------------

  app.use((req: Request, res: Response, next: NextFunction) => {
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
    //
    // Without this, a user who cancels the upload leaves a soffice process
    // burning CPU for the full timeout on a machine that is deliberately
    // CPU-capped.
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
  });

  // --- Health ---------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    // We only ever listen after preflight has confirmed soffice is on PATH, so
    // reaching this handler at all is the confirmation.
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify({ status: 'ok' }));
  });

  // --- API documentation ----------------------------------------------------

  if (ENABLE_DOCS) {
    // Registered before the catch-all 404 below, which would otherwise swallow
    // them and answer with the JSON error envelope.
    app.get('/openapi.json', async (_req: Request, res: Response) => {
      const spec = await loadOpenApiDocument();
      if (!spec) {
        respondJson(res, Errors.internal('openapi.yaml could not be loaded'), 500);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.status(200).end(JSON.stringify(spec.json));
    });

    app.get('/openapi.yaml', async (_req: Request, res: Response) => {
      const spec = await loadOpenApiDocument();
      if (!spec) {
        respondJson(res, Errors.internal('openapi.yaml could not be loaded'), 500);
        return;
      }
      res.setHeader('Content-Type', 'application/yaml');
      res.status(200).end(spec.yaml);
    });

    app.get('/docs', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).end(swaggerUiHtml());
    });
  }

  // --- Conversion -----------------------------------------------------------

  const upload = multer({
    storage: multer.diskStorage({
      // The upload lands directly in this request's own temp dir under a
      // server-generated name. The client's filename is never used for a path.
      destination: (req, _file, cb) => {
        const ctx = contexts.get(req);
        if (!ctx?.workspace) {
          cb(Errors.internal('workspace missing before upload'), '');
          return;
        }
        cb(null, ctx.workspace);
      },
      filename: (req, _file, cb) => {
        const ctx = contexts.get(req);
        // `extension` was validated in fileFilter, which multer runs first.
        cb(null, inputFileNameFor(ctx?.extension ?? '.docx'));
      },
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const ctx = contexts.get(_req);
      // The import filter is chosen from the extension of the FILENAME, never
      // from `file.mimetype`. The client deliberately declares
      // application/octet-stream, and a hostile client could declare anything
      // at all - the extension is the only part of the name we act on, and we
      // validate it against a fixed allowlist before it touches disk.
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (!isAllowedExtension(extension)) {
        cb(Errors.unsupported());
        return;
      }
      if (ctx) ctx.extension = extension;
      cb(null, true);
    },
  });

  app.post(
    '/convert',
    (req: Request, _res: Response, next: NextFunction) => {
      const ctx = contexts.get(req)!;
      if (!rateLimiter.check(req.ip ?? 'unknown')) {
        next(Errors.rateLimited());
        return;
      }
      // Refuse before the client uploads 25MB we have nowhere to put. The
      // authoritative check is still the queue's own acquire().
      if (!queue.hasCapacity()) {
        next(Errors.busy());
        return;
      }
      // Create the workspace before parsing, so the file streams straight into
      // the directory it will be converted in and cleaned up with.
      createWorkspace()
        .then((workspace) => {
          ctx.workspace = workspace;
          next();
        })
        .catch(next);
    },
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      const ctx = contexts.get(req)!;
      ctx.bytes = req.file?.size;

      try {
        if (!req.file) {
          throw Errors.badRequest('no file part named "file"');
        }
        const extension = ctx.extension;
        if (!extension) {
          throw Errors.unsupported();
        }
        // A zero-byte upload is not a document, but LibreOffice cheerfully opens
        // it as an empty one and exports a perfectly valid blank PDF - which
        // would be a 200 carrying a document the user never had. Reject it here,
        // where we still know it was empty.
        if (req.file.size === 0) {
          throw Errors.convertFailed('uploaded file was empty');
        }

        const pdf = await queue.run(ctx.controller.signal, async () => {
          const result = await convertToPdf({
            workspace: ctx.workspace!,
            extension,
            signal: ctx.controller.signal,
          });
          return result.pdf;
        });

        if (res.writableEnded || ctx.controller.signal.aborted) {
          // The client left while we were working. There is nobody to answer.
          logRequest(ctx, 'client_gone');
          return;
        }

        // The PDF is in memory now, so the input, the LibreOffice profile and
        // the output copy on disk are all dead weight. Drop them before writing
        // the response, so the space is reclaimed the moment the client has its
        // file rather than a few milliseconds later.
        await cleanup(ctx);

        // Exactly `application/pdf`, no charset suffix: the client inspects
        // this header and refuses anything that does not match.
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', String(pdf.length));
        res.status(200).end(pdf);
        logRequest(ctx, 'ok', { status: 200 });
      } catch (error) {
        if (error instanceof ClientGoneError) {
          logRequest(ctx, 'client_gone');
          return;
        }
        const appError = toAppError(error);
        logRequest(ctx, 'error', {
          status: appError.status,
          code: appError.code,
          detail: appError.cause instanceof Error ? appError.cause.message : undefined,
        });
        next(error);
      } finally {
        // Every remaining path: conversion failure, timeout, bad request.
        // Idempotent, so the success path above having already cleaned up is
        // fine. `res.on('close')` is the third net, for the paths where this
        // handler never ran at all because multer rejected the upload.
        await cleanup(ctx);
      }
    },
  );

  // --- Every remaining response is the JSON envelope ------------------------

  app.use((_req: Request, res: Response) => {
    // A 404 here means the client asked for a path this service does not serve,
    // which in practice means the APK is older than the server. Say something
    // the person holding the phone can act on.
    const error = new AppError(
      'E_BAD_REQUEST',
      404,
      'The converter is not available at this address. Please update the app and try again.',
    );
    respondJson(res, error);
  });

  app.use(async (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const ctx = contexts.get(req);
    const appError = toAppError(error);
    if (ctx) {
      logRequest(ctx, 'error', { status: appError.status, code: appError.code });
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
  });

  return app;
}

async function cleanup(ctx: RequestContext): Promise<void> {
  const dir = ctx.workspace;
  ctx.workspace = undefined;
  if (dir) await removeWorkspace(dir).catch(() => {});
}

/**
 * Map anything thrown anywhere into the error contract.
 *
 * multer and body-parser have their own error types and, left alone, they
 * render an HTML error page - which the client would see as "the server is
 * broken" rather than as a sentence it can show the user.
 */
function toAppError(error: unknown): AppError {
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
    if (candidate.type === 'entity.too.large' || candidate.status === 413 || candidate.statusCode === 413) {
      return Errors.tooLarge();
    }
  }

  return Errors.internal(error);
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Boot sequence, in the order that makes failure obvious.
 *
 * Preflight first: if soffice is missing or the fonts are absent the process
 * exits non-zero here, before it ever accepts a request. Both of those failures
 * are invisible at runtime - they show up as 500s or, much worse, as PDFs that
 * paginate differently from Word while looking completely fine.
 */
export async function startServer(port = PORT): Promise<StartedServer> {
  const report = await preflight();
  console.log(
    JSON.stringify({
      outcome: 'preflight_ok',
      soffice: report.sofficeVersion,
      fonts: report.fonts,
    }),
  );

  if (!SKIP_WARMUP) {
    const bytes = await warmUp();
    console.log(JSON.stringify({ outcome: 'warmup_ok', bytes }));
  }

  // Sweep what a previous crash left behind, then keep sweeping.
  const swept = await sweepStaleWorkspaces();
  if (swept > 0) console.log(JSON.stringify({ outcome: 'swept_stale_workspaces', count: swept }));
  const sweepTimer = setInterval(() => {
    void sweepStaleWorkspaces().then((count) => {
      if (count > 0) console.log(JSON.stringify({ outcome: 'swept_stale_workspaces', count }));
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const app = createApp();
  const server = createServer(app);

  // The client aborts at 120s. Anything still trickling in after that is
  // already a lost cause, so let the socket go rather than hold it forever.
  server.requestTimeout = 120_000;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve) => server.listen(port, HOST, resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.log(JSON.stringify({ outcome: 'listening', host: HOST, port: boundPort }));

  const close = async () => {
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, port: boundPort, close };
}

// pathToFileURL rather than string concatenation: a checkout under a path with
// a space or a non-ASCII character would otherwise never match, and the service
// would start and then silently do nothing.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  startServer()
    .then(({ close }) => {
      const shutdown = (signal: string) => {
        console.log(JSON.stringify({ outcome: 'shutdown', signal }));
        void close().then(() => process.exit(0));
        // Do not let a stuck connection hold the process open forever.
        setTimeout(() => process.exit(0), 10_000).unref();
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error: unknown) => {
      if (error instanceof PreflightError) {
        console.error(`\n${error.message}\n`);
      } else {
        console.error(error);
      }
      process.exit(1);
    });
}

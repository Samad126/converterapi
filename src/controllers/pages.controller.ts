/**
 * The page-manipulation endpoints, as HTTP: merge, split, remove pages,
 * extract pages, organize (reorder), and scan-to-PDF.
 *
 * These live apart from `convert.controller.ts` because they do not fit its
 * shape at all - one file in, one target in the URL, one file or archive out.
 * A merge takes several files and no target; a split takes one file and a
 * page-count field; remove/extract/organize each take one file and a
 * page-selection field. None of that is expressible as `/convert/{target}`
 * without stretching the URL into carrying parameters it was never meant to.
 *
 * What IS shared with `convert.controller.ts`: the admission gate (rate limit
 * and queue capacity, checked before a byte is read), the workspace lifecycle,
 * and the response shape (a file, or a ZIP when the answer is several files).
 */
import fsp from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';

import { MAX_PAGE_OPERATION_TOTAL_BYTES } from '../config.ts';
import { AppError, ClientGoneError, Errors } from '../errors.ts';
import { contentDispositionFor, downloadNameFor } from '../lib/download-name.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { isPermutationOfAllPages, parsePageSelection } from '../lib/page-ranges.ts';
import { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import { zipStored } from '../lib/zip.ts';
import {
  imagesToPdf,
  mergePdfs,
  pdfPageCount,
  removePages,
  selectPages,
  splitPdf,
  type ScanImage,
} from '../services/pdf-pages.service.ts';
import { createWorkspace } from '../services/workspace.service.ts';
import { cleanup, getContext, logRequest } from '../middleware/request-context.ts';

export interface PagesControllerDeps {
  queue: BoundedQueue;
  rateLimiter: RateLimiter;
}

export interface PagesController {
  admit: (req: Request, _res: Response, next: NextFunction) => void;
  prepareWorkspace: (req: Request, _res: Response, next: NextFunction) => void;
  merge: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  split: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  removePages: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  extractPages: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  organize: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  scanToPdf: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

interface PagesResult {
  /** One entry, or several when `archive` is true. */
  files: Array<{ name: string; data: Buffer }>;
  archive: boolean;
  downloadName: string;
}

export function createPagesController(deps: PagesControllerDeps): PagesController {
  const { queue, rateLimiter } = deps;

  const admit: PagesController['admit'] = (req, _res, next) => {
    if (!rateLimiter.check(req.ip ?? 'unknown')) {
      next(Errors.rateLimited());
      return;
    }
    if (!queue.hasCapacity()) {
      next(Errors.busy());
      return;
    }
    next();
  };

  const prepareWorkspace: PagesController['prepareWorkspace'] = (req, _res, next) => {
    createWorkspace()
      .then((workspace) => {
        getContext(req).workspace = workspace;
        next();
      })
      .catch(next);
  };

  /**
   * Run one operation to completion and answer the request - the shared
   * shape every handler below reduces to: gate on the queue, produce a
   * result, send it, clean up, log it. Identical to how
   * `convert.controller.ts` runs a conversion, because the failure modes
   * (client left, conversion threw, workspace needs reclaiming either way)
   * are the same failure modes.
   */
  async function run(
    req: Request,
    res: Response,
    next: NextFunction,
    operation: string,
    produce: () => Promise<PagesResult>,
  ): Promise<void> {
    const ctx = getContext(req);
    ctx.operation = operation;

    try {
      const result = await queue.run(ctx.controller.signal, produce);

      if (res.writableEnded || ctx.controller.signal.aborted) {
        logRequest(ctx, 'client_gone');
        return;
      }

      await cleanup(ctx);
      sendPagesResult(res, result);
      logRequest(ctx, 'ok', { status: 200 });
    } catch (error) {
      if (error instanceof ClientGoneError) {
        logRequest(ctx, 'client_gone');
        return;
      }
      next(error);
    } finally {
      await cleanup(ctx);
    }
  }

  const merge: PagesController['merge'] = async (req, res, next) => {
    const ctx = getContext(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    ctx.bytes = files.reduce((total, file) => total + file.size, 0);

    await run(req, res, next, 'merge', async () => {
      if (files.length < 2) {
        throw Errors.tooFewFiles('Merging needs at least two PDF files.');
      }
      await assertUploadsUsable(files);

      const buffers = await Promise.all(files.map((file) => fsp.readFile(file.path)));
      const merged = await mergePdfs(buffers);

      return {
        files: [{ name: 'merged.pdf', data: merged }],
        archive: false,
        downloadName: 'merged.pdf',
      };
    });
  };

  const split: PagesController['split'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'split', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const every = parsePositivePageCount(req.body?.every);
      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      if (pageCount === 0) {
        throw Errors.convertFailed('this PDF has no pages');
      }

      const parts = await splitPdf(buffer, every);
      const downloadName = downloadNameFor(file.originalname ?? '', '.zip');

      return {
        files: parts.map((data, index) => ({ name: `part-${index + 1}.pdf`, data })),
        archive: true,
        downloadName,
      };
    });
  };

  const removePagesHandler: PagesController['removePages'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'remove-pages', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const indices = parsePageSelection(requireField(req, 'pages'), pageCount);

      const result = await removePages(buffer, new Set(indices));
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const extractPages: PagesController['extractPages'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'extract-pages', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const indices = parsePageSelection(requireField(req, 'pages'), pageCount);

      const result = await selectPages(buffer, indices);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const organize: PagesController['organize'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'organize', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const indices = parsePageSelection(requireField(req, 'order'), pageCount);
      if (!isPermutationOfAllPages(indices, pageCount)) {
        throw Errors.badPageRange(
          `The order must name every page exactly once (1-${pageCount}), with no repeats and none missing.`,
        );
      }

      const result = await selectPages(buffer, indices);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const scanToPdf: PagesController['scanToPdf'] = async (req, res, next) => {
    const ctx = getContext(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    ctx.bytes = files.reduce((total, file) => total + file.size, 0);

    await run(req, res, next, 'scan-to-pdf', async () => {
      if (files.length < 1) {
        throw Errors.tooFewFiles('Scan to PDF needs at least one image.');
      }
      await assertUploadsUsable(files, { skipEncryptionCheck: true });

      const images: ScanImage[] = await Promise.all(
        files.map(async (file) => ({
          data: await fsp.readFile(file.path),
          format: file.originalname?.toLowerCase().endsWith('.png') ? ('png' as const) : ('jpg' as const),
        })),
      );
      const pdf = await imagesToPdf(images);

      return { files: [{ name: 'scanned.pdf', data: pdf }], archive: false, downloadName: 'scanned.pdf' };
    });
  };

  return {
    admit,
    prepareWorkspace,
    merge,
    split,
    removePages: removePagesHandler,
    extractPages,
    organize,
    scanToPdf,
  };
}

/** `req.file`, or a clear internal error if the upload middleware never set it. */
function requireSingleFile(req: Request): Express.Multer.File {
  if (!req.file) throw Errors.badRequest('no file part named "file"');
  return req.file;
}

/** A required multipart text field, trimmed - `pages`, `order`. */
function requireField(req: Request, name: string): string {
  const value = req.body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Errors.badPageRange(`The "${name}" field is required.`);
  }
  return value;
}

/** `every` for `/pdf/split`: a positive whole number of pages, defaulting to 1. */
function parsePositivePageCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
    throw Errors.badPageRange('The "every" field must be a positive whole number of pages.');
  }
  return Number.parseInt(raw, 10);
}

/**
 * Checks every handler needs before touching pdf-lib: nothing is empty, the
 * combined size is within budget, and (unless told to skip - scan-to-PDF's
 * images are not PDFs) nothing is password protected.
 */
async function assertUploadsUsable(
  files: readonly Express.Multer.File[],
  options: { skipEncryptionCheck?: boolean } = {},
): Promise<void> {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_PAGE_OPERATION_TOTAL_BYTES) {
    throw Errors.tooLarge(`combined upload of ${totalBytes} bytes exceeds the per-request limit`);
  }
  for (const file of files) {
    if (file.size === 0) {
      throw Errors.convertFailed(`${file.path} was empty`);
    }
    if (!options.skipEncryptionCheck && (await isPasswordProtected(file.path))) {
      throw Errors.encrypted();
    }
  }
}

/** Send a `PagesResult` the same way `convert.controller.ts` sends a conversion's. */
function sendPagesResult(res: Response, result: PagesResult): void {
  if (result.archive) {
    const archive = zipStored(result.files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDispositionFor(result.downloadName));
    res.setHeader('Content-Length', String(archive.length));
    res.status(200).end(archive);
    return;
  }

  const file = result.files[0];
  if (!file) throw new AppError('E_INTERNAL', 500, 'Something went wrong on the server.');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDispositionFor(result.downloadName));
  res.setHeader('Content-Length', String(file.data.length));
  res.status(200).end(file.data);
}

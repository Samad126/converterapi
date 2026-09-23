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
 *
 * Request parsing/validation lives in `pages.controller.parsers.ts`, and
 * reading engine output back off disk/writing the response lives in
 * `pages.controller.io.ts` - both pure functions with no dependency on this
 * factory's `deps` closure, split out to keep this file to route wiring and
 * the handlers themselves.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { CONVERT_TIMEOUT_MS } from '../config.ts';
import { ClientGoneError, Errors } from '../errors.ts';
import { downloadNameFor } from '../lib/download-name.ts';
import { isPermutationOfAllPages, parsePageSelection } from '../lib/page-ranges.ts';
import { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import {
  addPageNumbers,
  addWatermark,
  cropPages,
  editPdf,
  fillForm as fillFormFields,
  imagesToPdf,
  listFormFields,
  mergePdfs,
  pdfPageCount,
  removePages,
  rotatePages,
  selectPages,
  signPdf,
  splitPdf,
  type EditImage,
  type ScanImage,
  type SignImage,
} from '../services/pdf-pages.service.ts';
import { runPdfCompare, runPdfEngine, runPdfRedact } from '../engines/pdf-engine.engine.ts';
import { compressWithQpdf, protectWithQpdf, repairWithQpdf, unlockWithQpdf } from '../engines/qpdf.engine.ts';
import { createWorkspace } from '../services/workspace.service.ts';
import { cleanup, getContext, logRequest } from '../middleware/request-context.ts';
import { assertUploadsUsable, readPdfCompareOutput, readPdfEngineOutput, readQpdfOutput, sendPagesResult, type PagesResult } from './pages.controller.io.ts';
import {
  parseBooleanField,
  parseCompressLevel,
  parseCropMargins,
  parseEditElements,
  parseFormFieldsJson,
  parsePageNumberPosition,
  parsePositivePageCount,
  parseRedactAreas,
  parseRotationDegrees,
  parseSignElements,
  parseStartAt,
  requireField,
  requireNonEmptyField,
  requireSingleFile,
  requireWorkspace,
} from './pages.controller.parsers.ts';

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
  rotate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  watermark: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  protect: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  unlock: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  crop: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  pageNumbers: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  repair: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  compress: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  ocr: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  formFields: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  fillForm: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  compare: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  sign: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  redact: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  edit: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

export function createPagesController(deps: PagesControllerDeps): PagesController {
  const { queue, rateLimiter } = deps;

  const admit: PagesController['admit'] = (req, _res, next) => {
    if (!rateLimiter.check(req.ip ?? 'unknown')) {
      const error = Errors.rateLimited();
      error.retryAfterSeconds = rateLimiter.retryAfterSeconds(req.ip ?? 'unknown');
      next(error);
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

  /**
   * The JSON-response twin of `run`, above - identical shape (gate on the
   * queue, produce a result, send it, clean up, log it) except the result IS
   * the response body rather than a file/archive to wrap in `Content-
   * Disposition` headers. `/pdf/form-fields` and `/pdf/compare` are the only
   * two endpoints in this file that answer with structured data instead of a
   * document, so they get their own tiny send path rather than stretching
   * `PagesResult`/`sendPagesResult` to carry a JSON variant those two never
   * otherwise need.
   */
  async function runJson(
    req: Request,
    res: Response,
    next: NextFunction,
    operation: string,
    produce: () => Promise<unknown>,
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
      const body = Buffer.from(JSON.stringify(result), 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', String(body.length));
      res.status(200).end(body);
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

  const rotate: PagesController['rotate'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'rotate', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const delta = parseRotationDegrees(req.body?.degrees);
      const pagesField = req.body?.pages;
      const indices =
        typeof pagesField === 'string' && pagesField.trim() !== ''
          ? parsePageSelection(pagesField, pageCount)
          : undefined;

      const result = await rotatePages(buffer, delta, indices);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const watermark: PagesController['watermark'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'watermark', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const text = requireNonEmptyField(req, 'text');
      const pagesField = req.body?.pages;
      const indices =
        typeof pagesField === 'string' && pagesField.trim() !== ''
          ? parsePageSelection(pagesField, pageCount)
          : undefined;

      const result = await addWatermark(buffer, text, indices);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const protect: PagesController['protect'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'protect', async () => {
      const file = requireSingleFile(req);
      // A file that is already encrypted cannot be re-encrypted by qpdf
      // without first supplying the password it already has - "protect an
      // already-protected file" is not a coherent request, so it gets the
      // same E_ENCRYPTED every other page endpoint gives an encrypted input.
      await assertUploadsUsable([file]);
      const password = requireNonEmptyField(req, 'password');

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'output.pdf');
      const outcome = await protectWithQpdf({
        inputPath: file.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
        password,
      });
      const result = await readQpdfOutput(outcome, outputPath);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const unlock: PagesController['unlock'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'unlock', async () => {
      const file = requireSingleFile(req);
      // Deliberately skip the usual encryption check: the whole point of
      // this endpoint is that the input IS encrypted, and refusing it for
      // being encrypted would make the endpoint refuse every file it is
      // meant to accept.
      await assertUploadsUsable([file], { skipEncryptionCheck: true });
      const password = requireNonEmptyField(req, 'password');

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'output.pdf');
      const outcome = await unlockWithQpdf({
        inputPath: file.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
        password,
      });
      const result = await readQpdfOutput(outcome, outputPath, { wrongPasswordAware: true });
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const crop: PagesController['crop'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'crop', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const margins = parseCropMargins(req.body);
      const pagesField = req.body?.pages;
      const indices =
        typeof pagesField === 'string' && pagesField.trim() !== ''
          ? parsePageSelection(pagesField, pageCount)
          : undefined;

      const result = await cropPages(buffer, margins, indices);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const pageNumbers: PagesController['pageNumbers'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'page-numbers', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const position = parsePageNumberPosition(req.body?.position);
      const startAt = parseStartAt(req.body?.startAt);

      const result = await addPageNumbers(buffer, { position, startAt });
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const repair: PagesController['repair'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'repair', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'output.pdf');
      const outcome = await repairWithQpdf({
        inputPath: file.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
      });
      const result = await readQpdfOutput(outcome, outputPath, { warningsAreSuccess: true });
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const compress: PagesController['compress'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'compress', async () => {
      const file = requireSingleFile(req);
      // Same reasoning as `/pdf/protect`: qpdf needs the file unlocked to
      // read and rewrite its streams at all, so an already-encrypted input
      // gets the same E_ENCRYPTED every other page endpoint gives one.
      await assertUploadsUsable([file]);
      const level = parseCompressLevel(req.body?.level);

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'output.pdf');
      const outcome = await compressWithQpdf({
        inputPath: file.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
        level,
      });
      // Deliberately NOT `warningsAreSuccess`, unlike `/pdf/repair`: someone
      // asking to shrink a file is not asking to also silently accept
      // whatever damage qpdf's exit-3 recovery path papered over along the
      // way. If the input is broken enough to warn, that surprise belongs to
      // `/pdf/repair`, not to a compression request that never mentioned it.
      const result = await readQpdfOutput(outcome, outputPath);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const ocr: PagesController['ocr'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'ocr', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);
      const force = parseBooleanField(req.body?.force, 'force', false);

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'output.pdf');
      const outcome = await runPdfEngine({
        operation: 'ocr',
        inputPath: file.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
        force,
      });
      const result = await readPdfEngineOutput(outcome, outputPath);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const formFields: PagesController['formFields'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await runJson(req, res, next, 'form-fields', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      return listFormFields(buffer);
    });
  };

  const fillFormHandler: PagesController['fillForm'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'fill-form', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const values = parseFormFieldsJson(req.body?.fields);
      const flatten = parseBooleanField(req.body?.flatten, 'flatten', false);

      const buffer = await fsp.readFile(file.path);
      const result = await fillFormFields(buffer, values, { flatten });
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const compare: PagesController['compare'] = async (req, res, next) => {
    const ctx = getContext(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    ctx.bytes = files.reduce((total, file) => total + file.size, 0);

    await runJson(req, res, next, 'compare', async () => {
      if (files.length !== 2) {
        throw Errors.tooFewFiles('Comparing needs exactly two PDF files.');
      }
      await assertUploadsUsable(files);

      const workspace = requireWorkspace(req);
      const outputPath = join(workspace, 'compare.json');
      const outcome = await runPdfCompare({
        inputPathA: files[0]!.path,
        inputPathB: files[1]!.path,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
      });
      return readPdfCompareOutput(outcome, outputPath);
    });
  };

  const sign: PagesController['sign'] = async (req, res, next) => {
    const ctx = getContext(req);
    // `.fields()` middleware shapes `req.files` as `{ <fieldName>: File[] }`
    // rather than the flat `File[]` every other multi-file handler in this
    // file sees from `.array()` - see `createSignUploadMiddleware`.
    const filesByField = (req.files as Record<string, Express.Multer.File[]> | undefined) ?? {};
    const file = filesByField.file?.[0];
    const imageFiles = filesByField.images ?? [];
    ctx.bytes = (file?.size ?? 0) + imageFiles.reduce((total, f) => total + f.size, 0);

    await run(req, res, next, 'sign', async () => {
      if (!file) throw Errors.badRequest('no file part named "file"');
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const elements = parseSignElements(req.body?.elements, pageCount, imageFiles.length);

      const images: SignImage[] = await Promise.all(
        imageFiles.map(async (imageFile) => ({
          data: await fsp.readFile(imageFile.path),
          format: imageFile.originalname?.toLowerCase().endsWith('.png') ? ('png' as const) : ('jpg' as const),
        })),
      );

      const result = await signPdf(buffer, elements, images);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const redact: PagesController['redact'] = async (req, res, next) => {
    const ctx = getContext(req);
    ctx.bytes = req.file?.size;

    await run(req, res, next, 'redact', async () => {
      const file = requireSingleFile(req);
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const areas = parseRedactAreas(req.body?.areas, pageCount);

      const workspace = requireWorkspace(req);
      const areasPath = join(workspace, 'redact-areas.json');
      await fsp.writeFile(areasPath, JSON.stringify(areas), 'utf8');

      const outputPath = join(workspace, 'output.pdf');
      const outcome = await runPdfRedact({
        inputPath: file.path,
        areasPath,
        outputPath,
        workspace,
        deadline: Date.now() + CONVERT_TIMEOUT_MS,
        signal: ctx.controller.signal,
      });
      const result = await readPdfEngineOutput(outcome, outputPath);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
    });
  };

  const edit: PagesController['edit'] = async (req, res, next) => {
    const ctx = getContext(req);
    // Same `.fields()` shape as `sign` - see its own comment on this line.
    const filesByField = (req.files as Record<string, Express.Multer.File[]> | undefined) ?? {};
    const file = filesByField.file?.[0];
    const imageFiles = filesByField.images ?? [];
    ctx.bytes = (file?.size ?? 0) + imageFiles.reduce((total, f) => total + f.size, 0);

    await run(req, res, next, 'edit', async () => {
      if (!file) throw Errors.badRequest('no file part named "file"');
      await assertUploadsUsable([file]);

      const buffer = await fsp.readFile(file.path);
      const pageCount = await pdfPageCount(buffer);
      const elements = parseEditElements(req.body?.elements, pageCount, imageFiles.length);

      const images: EditImage[] = await Promise.all(
        imageFiles.map(async (imageFile) => ({
          data: await fsp.readFile(imageFile.path),
          format: imageFile.originalname?.toLowerCase().endsWith('.png') ? ('png' as const) : ('jpg' as const),
        })),
      );

      const result = await editPdf(buffer, elements, images);
      const downloadName = downloadNameFor(file.originalname ?? '', '.pdf');

      return { files: [{ name: downloadName, data: result }], archive: false, downloadName };
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
    rotate,
    watermark,
    protect,
    unlock,
    crop,
    pageNumbers,
    repair,
    compress,
    ocr,
    formFields,
    fillForm: fillFormHandler,
    compare,
    sign,
    redact,
    edit,
  };
}

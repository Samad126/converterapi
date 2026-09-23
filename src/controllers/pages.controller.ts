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
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { CONVERT_TIMEOUT_MS, MAX_PAGE_OPERATION_TOTAL_BYTES } from '../config.ts';
import { AppError, ClientGoneError, Errors } from '../errors.ts';
import { contentDispositionFor, downloadNameFor } from '../lib/download-name.ts';
import { isPasswordProtected } from '../lib/encrypted.ts';
import { isPermutationOfAllPages, parsePageSelection } from '../lib/page-ranges.ts';
import { BoundedQueue, RateLimiter } from '../lib/queue.ts';
import { zipStored } from '../lib/zip.ts';
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
  type CropMargins,
  type EditColor,
  type EditElement,
  type EditElementType,
  type EditImage,
  type EditPoint,
  type FormFieldValue,
  type PageNumberPosition,
  type ScanImage,
  type SignColor,
  type SignElement,
  type SignElementType,
  type SignFontStyle,
  type SignImage,
} from '../services/pdf-pages.service.ts';
import { runPdfCompare, runPdfEngine, runPdfRedact } from '../engines/pdf-engine.engine.ts';
import {
  compressWithQpdf,
  protectWithQpdf,
  repairWithQpdf,
  unlockWithQpdf,
  type CompressLevel,
} from '../engines/qpdf.engine.ts';
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

/** `req.file`, or a clear internal error if the upload middleware never set it. */
function requireSingleFile(req: Request): Express.Multer.File {
  if (!req.file) throw Errors.badRequest('no file part named "file"');
  return req.file;
}

/** The workspace `prepareWorkspace` created, for handlers that need its path directly. */
function requireWorkspace(req: Request): string {
  const workspace = getContext(req).workspace;
  if (!workspace) throw Errors.internal('workspace missing after prepareWorkspace');
  return workspace;
}

/** A required multipart text field, trimmed - `pages`, `order`. */
function requireField(req: Request, name: string): string {
  const value = req.body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Errors.badPageRange(`The "${name}" field is required.`);
  }
  return value;
}

/** A required, non-blank multipart text field - `text` and `password`. */
function requireNonEmptyField(req: Request, name: string): string {
  const value = req.body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Errors.invalidField(`The "${name}" field is required.`);
  }
  return value;
}

/** `degrees` for `/pdf/rotate`: any multiple of 90, clockwise. */
function parseRotationDegrees(raw: unknown): number {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw Errors.invalidField('The "degrees" field must be a whole number of degrees.');
  }
  const value = Number.parseInt(raw, 10);
  if (value % 90 !== 0) {
    throw Errors.invalidField('The "degrees" field must be a multiple of 90.');
  }
  return value;
}

/** A non-negative number from a form field, or `fallback` if it was omitted. */
function parseNonNegativeNumber(raw: unknown, fieldName: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    throw Errors.invalidField(`The "${fieldName}" field must be a non-negative number.`);
  }
  return Number.parseFloat(raw);
}

/** `left`/`right`/`top`/`bottom` for `/pdf/crop`, each in points, defaulting to 0. */
function parseCropMargins(body: Record<string, unknown> | undefined): CropMargins {
  return {
    left: parseNonNegativeNumber(body?.left, 'left', 0),
    right: parseNonNegativeNumber(body?.right, 'right', 0),
    top: parseNonNegativeNumber(body?.top, 'top', 0),
    bottom: parseNonNegativeNumber(body?.bottom, 'bottom', 0),
  };
}

const PAGE_NUMBER_POSITIONS: readonly PageNumberPosition[] = ['bottom-center', 'bottom-left', 'bottom-right'];

/** `position` for `/pdf/page-numbers`, defaulting to `bottom-center`. */
function parsePageNumberPosition(raw: unknown): PageNumberPosition {
  if (raw === undefined || raw === null || raw === '') return 'bottom-center';
  if (typeof raw !== 'string' || !PAGE_NUMBER_POSITIONS.includes(raw as PageNumberPosition)) {
    throw Errors.invalidField(`The "position" field must be one of: ${PAGE_NUMBER_POSITIONS.join(', ')}.`);
  }
  return raw as PageNumberPosition;
}

const COMPRESS_LEVELS: readonly CompressLevel[] = ['low', 'medium', 'high'];

/** `level` for `/pdf/compress`, defaulting to `medium` - see `qpdf.engine.ts` for what each one does. */
function parseCompressLevel(raw: unknown): CompressLevel {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  if (typeof raw !== 'string' || !COMPRESS_LEVELS.includes(raw as CompressLevel)) {
    throw Errors.invalidField(`The "level" field must be one of: ${COMPRESS_LEVELS.join(', ')}.`);
  }
  return raw as CompressLevel;
}

/** `startAt` for `/pdf/page-numbers`: a positive whole number, defaulting to 1. */
function parseStartAt(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
    throw Errors.invalidField('The "startAt" field must be a positive whole number.');
  }
  return Number.parseInt(raw, 10);
}

/**
 * A `true`/`false` multipart field, defaulting to `fallback` when omitted -
 * `force` on `/pdf/ocr`, `flatten` on `/pdf/fill-form`. Anything else typed
 * in is a mistake worth a clear `E_INVALID_FIELD` rather than being silently
 * coerced, the same reasoning `parseRotationDegrees` applies to `degrees`.
 */
function parseBooleanField(raw: unknown, fieldName: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw Errors.invalidField(`The "${fieldName}" field must be "true" or "false".`);
}

/**
 * The `fields` multipart field for `/pdf/fill-form`: JSON text naming a
 * value per form field. Parsed and shape-checked here rather than left to
 * `fillForm` in the service, so a malformed request never gets as far as
 * loading the PDF at all - the same "validate the request before touching
 * pdf-lib" order every other handler in this file follows.
 */
function parseFormFieldsJson(raw: unknown): Record<string, FormFieldValue> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "fields" field is required and must be a JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "fields" field must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Errors.invalidField('The "fields" field must be a JSON object mapping field names to values.');
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw Errors.invalidField(`The value given for field "${name}" must be a string or a boolean.`);
    }
  }
  return parsed as Record<string, FormFieldValue>;
}

const SIGN_ELEMENT_TYPES: readonly SignElementType[] = ['signature', 'initials', 'stamp', 'name', 'date', 'text'];
const SIGN_FONT_STYLES: readonly SignFontStyle[] = ['cursive', 'cursive2', 'plain'];
const SIGN_COLORS: readonly SignColor[] = ['black', 'red', 'blue', 'green'];

/**
 * The `elements` multipart field for `/pdf/sign`: JSON text describing every
 * mark to bake into the page. Parsed and fully shape-checked here, before
 * `signPdf` ever loads the PDF a second time (via `pdfPageCount` already
 * having loaded it once to know how many pages exist to validate `page`
 * against) - the same "validate the request before touching pdf-lib for the
 * real work" order `parseFormFieldsJson` follows for `/pdf/fill-form`.
 */
function parseSignElements(raw: unknown, pageCount: number, imageCount: number): SignElement[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "elements" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "elements" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "elements" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseSignElement(item, index, pageCount, imageCount));
}

/**
 * One entry of `elements`. Every field the person can control is checked by
 * name (mirroring `parseCropMargins`/`parsePageNumberPosition`'s style of
 * naming the exact field and problem), and the value/imageIndex rule is
 * enforced per the type-specific contract in `pdf-pages.service.ts`'s
 * `SignElement` doc comment: "stamp" REQUIRES `imageIndex` and forbids
 * `value`; "name"/"date"/"text" REQUIRE `value` and forbid `imageIndex`;
 * "signature"/"initials" need EXACTLY one of the two, either is valid.
 */
function parseSignElement(item: unknown, index: number, pageCount: number, imageCount: number): SignElement {
  const label = `elements[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== 'string' || !SIGN_ELEMENT_TYPES.includes(type as SignElementType)) {
    throw Errors.invalidField(`${label}.type must be one of: ${SIGN_ELEMENT_TYPES.join(', ')}.`);
  }

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  const geometry: Record<string, number> = {};
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const value = obj[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw Errors.invalidField(`${label}.${field} must be a finite number.`);
    }
    geometry[field] = value;
  }
  if (geometry.width! <= 0 || geometry.height! <= 0) {
    throw Errors.invalidField(`${label}.width and ${label}.height must both be positive.`);
  }

  const hasValue = obj.value !== undefined;
  const hasImageIndex = obj.imageIndex !== undefined;
  const isImageOnlyType = type === 'stamp';
  const isValueOnlyType = type === 'name' || type === 'date' || type === 'text';

  if (isImageOnlyType) {
    if (!hasImageIndex || hasValue) {
      throw Errors.invalidField(`${label}: type "stamp" requires "imageIndex" and must not have "value".`);
    }
  } else if (isValueOnlyType) {
    if (!hasValue || hasImageIndex) {
      throw Errors.invalidField(`${label}: type "${type}" requires "value" and must not have "imageIndex".`);
    }
  } else if (hasValue === hasImageIndex) {
    // signature / initials: exactly one of the two, whichever it is.
    throw Errors.invalidField(`${label}: exactly one of "value" or "imageIndex" is required for type "${type}".`);
  }

  let value: string | undefined;
  if (hasValue) {
    if (typeof obj.value !== 'string' || obj.value.trim() === '') {
      throw Errors.invalidField(`${label}.value must be a non-empty string.`);
    }
    value = obj.value;
  }

  let imageIndex: number | undefined;
  if (hasImageIndex) {
    const rawIndex = obj.imageIndex;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= imageCount) {
      throw Errors.invalidField(
        `${label}.imageIndex must reference one of the ${imageCount} uploaded "images" files.`,
      );
    }
    imageIndex = rawIndex;
  }

  let fontStyle: SignFontStyle | undefined;
  if (obj.fontStyle !== undefined) {
    if (typeof obj.fontStyle !== 'string' || !SIGN_FONT_STYLES.includes(obj.fontStyle as SignFontStyle)) {
      throw Errors.invalidField(`${label}.fontStyle must be one of: ${SIGN_FONT_STYLES.join(', ')}.`);
    }
    fontStyle = obj.fontStyle as SignFontStyle;
  }

  let color: SignColor | undefined;
  if (obj.color !== undefined) {
    if (typeof obj.color !== 'string' || !SIGN_COLORS.includes(obj.color as SignColor)) {
      throw Errors.invalidField(`${label}.color must be one of: ${SIGN_COLORS.join(', ')}.`);
    }
    color = obj.color as SignColor;
  }

  return {
    type: type as SignElementType,
    page,
    x: geometry.x!,
    y: geometry.y!,
    width: geometry.width!,
    height: geometry.height!,
    value,
    imageIndex,
    fontStyle,
    color,
  };
}

const EDIT_ELEMENT_TYPES: readonly EditElementType[] = [
  'text',
  'image',
  'rectangle',
  'ellipse',
  'line',
  'freehand',
];
const EDIT_COLORS: readonly EditColor[] = ['black', 'red', 'blue', 'green', 'yellow', 'orange'];

/**
 * The `elements` multipart field for `/pdf/edit`: JSON text describing every
 * mark to draw. Same shape and same validate-before-`editPdf` order as
 * `parseSignElements` for `/pdf/sign`, its closest precedent - the
 * difference is entirely in what each element TYPE requires, since a
 * general-purpose editor's marks do not share one geometry the way a
 * signature/stamp's fixed box does. See `parseEditElement`.
 */
function parseEditElements(raw: unknown, pageCount: number, imageCount: number): EditElement[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "elements" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "elements" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "elements" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseEditElement(item, index, pageCount, imageCount));
}

/** A required, finite `field` on `obj`, labelled `${label}.${field}` in any error. */
function requireFiniteNumber(obj: Record<string, unknown>, field: string, label: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Errors.invalidField(`${label}.${field} must be a finite number.`);
  }
  return value;
}

/** The same, but additionally required to be > 0 - `width`/`height` on a box. */
function requirePositiveNumber(obj: Record<string, unknown>, field: string, label: string): number {
  const value = requireFiniteNumber(obj, field, label);
  if (value <= 0) throw Errors.invalidField(`${label}.${field} must be positive.`);
  return value;
}

/**
 * One entry of `/pdf/edit`'s `elements`. Unlike `parseSignElement`, where
 * every type shares one `x`/`y`/`width`/`height` box, each type here is
 * validated against exactly the fields `EditElement`'s doc comment says it
 * needs: a box for `text`/`image`/`rectangle`/`ellipse`, two endpoints for
 * `line`, a point list for `freehand`. Fields a type does not use are simply
 * ignored if present, the same tolerance `parseRedactArea` extends to
 * anything past what it names.
 */
function parseEditElement(item: unknown, index: number, pageCount: number, imageCount: number): EditElement {
  const label = `elements[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== 'string' || !EDIT_ELEMENT_TYPES.includes(type as EditElementType)) {
    throw Errors.invalidField(`${label}.type must be one of: ${EDIT_ELEMENT_TYPES.join(', ')}.`);
  }

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  let color: EditColor | undefined;
  if (obj.color !== undefined) {
    if (typeof obj.color !== 'string' || !EDIT_COLORS.includes(obj.color as EditColor)) {
      throw Errors.invalidField(`${label}.color must be one of: ${EDIT_COLORS.join(', ')}.`);
    }
    color = obj.color as EditColor;
  }

  let strokeWidth: number | undefined;
  if (obj.strokeWidth !== undefined) {
    strokeWidth = requirePositiveNumber(obj, 'strokeWidth', label);
  }

  let fill: boolean | undefined;
  if (obj.fill !== undefined) {
    if (typeof obj.fill !== 'boolean') throw Errors.invalidField(`${label}.fill must be true or false.`);
    fill = obj.fill;
  }

  const base = { type: type as EditElementType, page, color, strokeWidth, fill };

  if (type === 'text') {
    if (typeof obj.value !== 'string' || obj.value.trim() === '') {
      throw Errors.invalidField(`${label}.value must be a non-empty string.`);
    }
    let fontSize: number | undefined;
    if (obj.fontSize !== undefined) fontSize = requirePositiveNumber(obj, 'fontSize', label);
    return {
      ...base,
      value: obj.value,
      fontSize,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
    };
  }

  if (type === 'image') {
    const rawIndex = obj.imageIndex;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= imageCount) {
      throw Errors.invalidField(
        `${label}.imageIndex must reference one of the ${imageCount} uploaded "images" files.`,
      );
    }
    return {
      ...base,
      imageIndex: rawIndex,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
      width: requirePositiveNumber(obj, 'width', label),
      height: requirePositiveNumber(obj, 'height', label),
    };
  }

  if (type === 'rectangle' || type === 'ellipse') {
    return {
      ...base,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
      width: requirePositiveNumber(obj, 'width', label),
      height: requirePositiveNumber(obj, 'height', label),
    };
  }

  if (type === 'line') {
    return {
      ...base,
      x1: requireFiniteNumber(obj, 'x1', label),
      y1: requireFiniteNumber(obj, 'y1', label),
      x2: requireFiniteNumber(obj, 'x2', label),
      y2: requireFiniteNumber(obj, 'y2', label),
    };
  }

  // freehand
  if (!Array.isArray(obj.points) || obj.points.length < 2) {
    throw Errors.invalidField(`${label}.points must be an array of at least 2 {x, y} points.`);
  }
  const points: EditPoint[] = obj.points.map((point, pointIndex) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) {
      throw Errors.invalidField(`${label}.points[${pointIndex}] must be a JSON object.`);
    }
    const pointObj = point as Record<string, unknown>;
    return {
      x: requireFiniteNumber(pointObj, 'x', `${label}.points[${pointIndex}]`),
      y: requireFiniteNumber(pointObj, 'y', `${label}.points[${pointIndex}]`),
    };
  });
  return { ...base, points };
}

/** One entry of `/pdf/redact`'s `areas` field - see `parseRedactAreas`. */
interface RedactArea {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The `areas` multipart field for `/pdf/redact`: a JSON array naming every
 * rectangle to strip. Parsed and fully shape-checked here, before
 * `pdf_engine.py` is ever invoked - the same "validate the request before
 * touching the real engine" order `parseSignElements` follows for
 * `/pdf/sign` (its closest precedent: also a JSON-array-of-placement-objects
 * field). `page` is checked against `pageCount` here, client-side of the
 * Python call, the same defense-in-depth every other page-selecting
 * endpoint in this file already applies via `pdfPageCount` - `pdf_engine.py`
 * itself also rejects an out-of-range `page`, but that check existing too
 * does not make this one redundant: this one is what keeps a malformed
 * request from ever reaching a subprocess at all.
 *
 * An empty array is rejected rather than treated as a no-op: unlike
 * `/pdf/sign`'s `elements` (where a caller might reasonably build up marks
 * across several requests), "redact nothing" is not a coherent redaction
 * request - there is no reason to invoke this endpoint at all with nothing
 * to remove, and treating it as a silent success would only hide a caller
 * bug that forgot to populate `areas`.
 */
function parseRedactAreas(raw: unknown, pageCount: number): RedactArea[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "areas" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "areas" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "areas" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseRedactArea(item, index, pageCount));
}

/** One entry of `areas` - see `parseRedactAreas`. */
function parseRedactArea(item: unknown, index: number, pageCount: number): RedactArea {
  const label = `areas[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  const geometry: Record<string, number> = {};
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const value = obj[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw Errors.invalidField(`${label}.${field} must be a finite number.`);
    }
    geometry[field] = value;
  }
  if (geometry.width! <= 0 || geometry.height! <= 0) {
    throw Errors.invalidField(`${label}.width and ${label}.height must both be positive.`);
  }

  return {
    page,
    x: geometry.x!,
    y: geometry.y!,
    width: geometry.width!,
    height: geometry.height!,
  };
}

/**
 * Turn a `pdf_engine.py` run that produces a PDF (`ocr`, `redact`) into
 * either the bytes it produced or the right AppError - the `pdf_engine.py`
 * twin of `readQpdfOutput` below, for the page-operation endpoints that go
 * through the Python engine rather than qpdf or pdf-lib.
 */
async function readPdfEngineOutput(
  outcome: import('../engines/soffice.engine.ts').ProcessOutcome,
  outputPath: string,
): Promise<Buffer> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  if (outcome.kind === 'exited' && (outcome.exitCode ?? -1) !== 0) {
    throw Errors.convertFailed(outcome.stderr || `pdf_engine.py exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath);
    if (data.length === 0) throw new Error('pdf_engine.py produced an empty file');
    return data;
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

/**
 * Turn a `pdf_engine.py` `compare` run into the parsed JSON report it wrote,
 * or the right AppError. Unlike every PDF-producing outcome in this file,
 * an empty output is not itself suspicious to check for - a valid, empty-ish
 * JSON body is small but never zero bytes - so this only has to distinguish
 * "the process didn't finish" from "the process wrote something that isn't
 * the JSON it promised".
 */
async function readPdfCompareOutput(
  outcome: import('../engines/soffice.engine.ts').ProcessOutcome,
  outputPath: string,
): Promise<unknown> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  if (outcome.kind === 'exited' && (outcome.exitCode ?? -1) !== 0) {
    throw Errors.convertFailed(outcome.stderr || `pdf_engine.py exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

/**
 * Turn a qpdf run into either the bytes it produced or the right AppError.
 *
 * qpdf writes nothing and exits non-zero on failure, so success is "exit 0
 * (or exit 3, for `/pdf/repair` - see below) and a file appeared" - the same
 * "exit code alone carries no information" caution `soffice.engine.ts`
 * documents for LibreOffice, checked the same way: look at what actually
 * landed on disk.
 */
async function readQpdfOutput(
  outcome: import('../engines/soffice.engine.ts').ProcessOutcome,
  outputPath: string,
  options: { wrongPasswordAware?: boolean; warningsAreSuccess?: boolean } = {},
): Promise<Buffer> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  // qpdf's own exit codes: 0 clean, 3 "warnings only" (the file was still
  // written), 2 a real error. `/pdf/repair` exists specifically for files
  // that trigger warnings - a damaged PDF that qpdf could only PARTIALLY
  // recover is exactly the case this endpoint is for, so exit 3 there is the
  // expected outcome, not a failure.
  const acceptable = options.warningsAreSuccess ? [0, 3] : [0];
  if (outcome.kind === 'exited' && !acceptable.includes(outcome.exitCode ?? -1)) {
    if (options.wrongPasswordAware && /invalid password/i.test(outcome.stderr)) {
      throw Errors.wrongPassword();
    }
    throw Errors.convertFailed(outcome.stderr || `qpdf exited ${outcome.exitCode}`);
  }
  try {
    const data = await fsp.readFile(outputPath);
    if (data.length === 0) throw new Error('qpdf produced an empty file');
    return data;
  } catch (error) {
    throw Errors.convertFailed(error);
  }
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

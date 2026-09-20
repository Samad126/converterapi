/**
 * Page-level PDF operations, apart from `/convert/{target}` because none of
 * them are a "one file becomes one format" request:
 *
 *   POST /pdf/merge          multiple PDFs  -> one merged PDF
 *   POST /pdf/split          one PDF        -> a ZIP of PDFs, `every` pages each
 *   POST /pdf/remove-pages   one PDF        -> a PDF with `pages` removed
 *   POST /pdf/extract-pages  one PDF        -> a PDF of only `pages`, in that order
 *   POST /pdf/organize       one PDF        -> a PDF reordered to `order`
 *   POST /pdf/scan-to-pdf    multiple images -> one PDF, one page per image
 *   POST /pdf/rotate         one PDF        -> a PDF with `pages` (or all) rotated `degrees`
 *   POST /pdf/watermark      one PDF        -> a PDF with `text` stamped across `pages` (or all)
 *   POST /pdf/protect        one PDF        -> the same PDF encrypted with `password`
 *   POST /pdf/unlock         one PDF        -> the same PDF decrypted with `password`
 *   POST /pdf/crop           one PDF        -> a PDF with `pages` (or all) cropped by margins
 *   POST /pdf/page-numbers   one PDF        -> a PDF with a number drawn on every page
 *   POST /pdf/repair         one PDF        -> the same PDF, rewritten to fix what qpdf can recover
 *   POST /pdf/ocr            one PDF        -> the same PDF with a searchable OCR text layer added
 *   POST /pdf/form-fields    one PDF        -> JSON describing every AcroForm field
 *   POST /pdf/fill-form      one PDF        -> a PDF with `fields` filled in (optionally flattened)
 *   POST /pdf/compare        two PDFs       -> JSON, a per-page text diff
 */
import { Router } from 'express';

import { createPagesController, type PagesControllerDeps } from '../controllers/pages.controller.ts';
import {
  createPdfFilesUploadMiddleware,
  createScanImagesUploadMiddleware,
  createSinglePdfUploadMiddleware,
} from '../middleware/pages-upload.ts';

export function createPagesRouter(deps: PagesControllerDeps): Router {
  const router = Router();
  const controller = createPagesController(deps);

  router.post(
    '/pdf/merge',
    controller.admit,
    controller.prepareWorkspace,
    createPdfFilesUploadMiddleware(),
    controller.merge,
  );

  router.post(
    '/pdf/split',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.split,
  );

  router.post(
    '/pdf/remove-pages',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.removePages,
  );

  router.post(
    '/pdf/extract-pages',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.extractPages,
  );

  router.post(
    '/pdf/organize',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.organize,
  );

  router.post(
    '/pdf/scan-to-pdf',
    controller.admit,
    controller.prepareWorkspace,
    createScanImagesUploadMiddleware(),
    controller.scanToPdf,
  );

  router.post(
    '/pdf/rotate',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.rotate,
  );

  router.post(
    '/pdf/watermark',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.watermark,
  );

  router.post(
    '/pdf/protect',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.protect,
  );

  router.post(
    '/pdf/unlock',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.unlock,
  );

  router.post(
    '/pdf/crop',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.crop,
  );

  router.post(
    '/pdf/page-numbers',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.pageNumbers,
  );

  router.post(
    '/pdf/repair',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.repair,
  );

  router.post(
    '/pdf/ocr',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.ocr,
  );

  router.post(
    '/pdf/form-fields',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.formFields,
  );

  router.post(
    '/pdf/fill-form',
    controller.admit,
    controller.prepareWorkspace,
    createSinglePdfUploadMiddleware(),
    controller.fillForm,
  );

  router.post(
    '/pdf/compare',
    controller.admit,
    controller.prepareWorkspace,
    createPdfFilesUploadMiddleware(),
    controller.compare,
  );

  return router;
}

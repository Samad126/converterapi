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

  return router;
}

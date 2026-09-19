/**
 * The conversion routes.
 *
 * Two paths, one handler:
 *
 *   POST /convert           -> PDF, which is what the shipped Android client
 *                              posts to and what it expects back
 *   POST /convert/<target>  -> any format in the matrix
 *
 * They share every middleware, including the upload, so the only difference
 * between them is the absence or presence of the target segment. That is the
 * point: the legacy path is not a special case maintained alongside the new
 * one, it is the new one with a default applied.
 */
import { Router } from 'express';

import {
  createConvertController,
  type ConvertControllerDeps,
} from '../controllers/convert.controller.ts';
import { createUploadMiddleware } from '../middleware/upload.ts';

export function createConvertRouter(deps: ConvertControllerDeps): Router {
  const router = Router();
  const controller = createConvertController(deps);
  const upload = createUploadMiddleware();

  router.post(
    ['/convert', '/convert/:target'],
    controller.admit,
    controller.validateTarget,
    controller.prepareWorkspace,
    upload.single('file'),
    controller.handle,
  );

  return router;
}

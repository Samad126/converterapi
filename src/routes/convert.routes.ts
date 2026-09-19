/**
 * The conversion route.
 *
 *   POST /convert/<target>  -> any format in the matrix, `pdf` included
 *
 * The target segment is REQUIRED. There is deliberately no bare `/convert`
 * alias: one address that means one thing is easier to document, to test and to
 * reason about than two addresses that mean the same thing, and a default
 * target is only ever a convenience for the caller - `POST /convert/pdf` is not
 * harder to write than `POST /convert`.
 *
 * A request to the bare path now falls through to the catch-all 404, whose
 * message is "The converter is not available at this address. Please update the
 * app and try again." For a client built against the old path that is, by
 * accident, exactly the right thing to say to the person holding the phone.
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
    '/convert/:target',
    controller.admit,
    controller.validateTarget,
    controller.prepareWorkspace,
    upload.single('file'),
    controller.handle,
  );

  return router;
}

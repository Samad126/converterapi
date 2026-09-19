/**
 * Accepting the upload.
 *
 * Two decisions here are load-bearing, and both are about not trusting the
 * client:
 *
 *   - The import filter is chosen from the extension of the FILENAME, never
 *     from `file.mimetype`. The shipped Android client deliberately declares
 *     application/octet-stream, and a hostile client could declare anything at
 *     all - the extension is the only part of the name we act on, and it is
 *     validated against the matrix before it touches disk.
 *
 *   - The file is written under a SERVER-generated name. The client's own
 *     filename never reaches the filesystem, which is what makes path traversal
 *     a non-issue rather than something to sanitise carefully.
 */
import multer from 'multer';
import { extname } from 'node:path';

import { MAX_UPLOAD_BYTES } from '../config.ts';
import { Errors } from '../errors.ts';
import { isAllowedExtension } from '../formats.ts';
import { getContext } from './request-context.ts';
import { inputFileNameFor } from '../services/workspace.service.ts';

export function createUploadMiddleware() {
  return multer({
    storage: multer.diskStorage({
      // The upload lands directly in this request's own temp dir under a
      // server-generated name. The client's filename is never used for a path.
      destination: (req, _file, cb) => {
        const ctx = getContext(req);
        if (!ctx.workspace) {
          cb(Errors.internal('workspace missing before upload'), '');
          return;
        }
        cb(null, ctx.workspace);
      },
      filename: (req, _file, cb) => {
        const ctx = getContext(req);
        // `extension` was validated in fileFilter, which multer runs first.
        cb(null, inputFileNameFor(ctx.extension ?? '.docx'));
      },
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (!isAllowedExtension(extension)) {
        // Rejected before the body is written anywhere. The workspace was
        // created for this request, and the error handler reclaims it.
        cb(Errors.unsupported());
        return;
      }
      getContext(req).extension = extension;
      cb(null, true);
    },
  });
}

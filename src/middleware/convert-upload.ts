/**
 * Accepting the upload for `POST /convert/{target}` - one or more files under
 * one field name (`files`), each independently converted to the same target.
 *
 * Unlike `pages-upload.ts`'s `files` field, the accepted extension is not
 * fixed: any extension the conversion matrix accepts can appear, because each
 * file keeps its own source format and only shares the target with the rest
 * of the request. The extension is validated against `isAllowedExtension`,
 * never the declared MIME type, for the same reason `upload.ts` used to: the
 * shipped Android client deliberately declares `application/octet-stream` for
 * everything, and a hostile client could declare anything at all.
 *
 * `convert()` expects a workspace to itself (it writes to `<workspace>/input.
 * <ext>`, `<workspace>/out`, `<workspace>/lo-profile`), so each file gets its
 * own subdirectory of the request's workspace rather than sharing it the way
 * `pages-upload.ts`'s flat `file-<index>.<ext>` naming does - those endpoints
 * read every file once and never hand one to `convert()`.
 */
import { extname, join } from 'node:path';
import fsp from 'node:fs/promises';

import multer from 'multer';

import { MAX_CONVERT_FILES, MAX_UPLOAD_BYTES } from '../config.ts';
import { Errors } from '../errors.ts';
import { isAllowedExtension, type AllowedExtension } from '../formats.ts';
import { getContext } from './request-context.ts';
import { inputFileNameFor } from '../services/workspace.service.ts';

const FIELD_NAME = 'files';

export function createConvertUploadMiddleware() {
  return multer({
    storage: multer.diskStorage({
      // Runs once per part, in arrival order, before `filename` for that same
      // part - so the index assigned here is what `filename` (and the
      // controller, reading `ctx.bulkFiles` in the same order) both rely on.
      destination: (req, file, cb) => {
        const ctx = getContext(req);
        if (!ctx.workspace) {
          cb(Errors.internal('workspace missing before upload'), '');
          return;
        }
        const extension = extname(file.originalname ?? '').toLowerCase();
        if (!isAllowedExtension(extension)) {
          // Caught again in `fileFilter`, which runs first and would normally
          // have already rejected this - this is belt and braces so a future
          // reordering of multer's internals cannot slip an unvalidated
          // extension past the `as AllowedExtension` cast below.
          cb(Errors.unsupported(), '');
          return;
        }
        const index = ctx.uploadedFileCount ?? 0;
        ctx.uploadedFileCount = index + 1;
        const dir = join(ctx.workspace, `f${index}`);
        ctx.bulkFiles ??= [];
        ctx.bulkFiles.push({ originalName: file.originalname ?? '', extension, dir });
        fsp
          .mkdir(dir, { recursive: true })
          .then(() => cb(null, dir))
          .catch((error: unknown) => cb(error as Error, ''));
      },
      filename: (_req, file, cb) => {
        const extension = extname(file.originalname ?? '').toLowerCase() as AllowedExtension;
        cb(null, inputFileNameFor(extension));
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_CONVERT_FILES },
    fileFilter: (_req, file, cb) => {
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (!isAllowedExtension(extension)) {
        cb(Errors.unsupported());
        return;
      }
      cb(null, true);
    },
  }).array(FIELD_NAME, MAX_CONVERT_FILES);
}

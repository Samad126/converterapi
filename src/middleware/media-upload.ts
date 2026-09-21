/**
 * Accepting the upload for `POST /media/{target}` - exactly one file under
 * `files` (unlike `convert-upload.ts`, no batch mode: a job already models
 * one conversion, and a batch of async jobs is a different feature with its
 * own design questions this pass does not need to answer).
 *
 * Written into the JOB's own workspace, not `ctx.workspace` - see
 * `media.controller.ts`'s own comment on why: the generic `requestContext()`
 * middleware removes `ctx.workspace` the moment this request's response
 * finishes, which for `/media/{target}` is right after the `202`, while the
 * conversion itself keeps running for minutes afterwards.
 */
import { extname } from 'node:path';

import multer from 'multer';

import { MEDIA_MAX_UPLOAD_BYTES } from '../config.ts';
import { Errors } from '../errors.ts';
import { isMediaExtension } from '../formats-media.ts';
import { inputFileNameFor } from '../services/workspace.service.ts';
import type { AllowedExtension } from '../formats.ts';

const FIELD_NAME = 'files';

export interface MediaUploadLocals {
  mediaWorkspace: string;
}

export function createMediaUploadMiddleware() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const locals = req.res?.locals as Partial<MediaUploadLocals> | undefined;
        if (!locals?.mediaWorkspace) {
          cb(Errors.internal('media workspace missing before upload'), '');
          return;
        }
        cb(null, locals.mediaWorkspace);
      },
      filename: (_req, file, cb) => {
        const extension = extname(file.originalname ?? '').toLowerCase();
        // `inputFileNameFor` only cares about the extension string, so the
        // main matrix's `AllowedExtension` type is a harmless overcast here -
        // `fileFilter` below has already refused anything not a MediaExtension.
        cb(null, inputFileNameFor(extension as AllowedExtension));
      },
    }),
    limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (!isMediaExtension(extension)) {
        cb(Errors.unsupported(`This file type is not a supported audio/video format.`));
        return;
      }
      cb(null, true);
    },
  }).array(FIELD_NAME, 1);
}

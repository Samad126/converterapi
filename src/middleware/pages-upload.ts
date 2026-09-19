/**
 * Accepting uploads for the page endpoints (`/pdf/merge`, `/pdf/split`, and
 * friends) - the multi-file, PDF-only or image-only twin of `upload.ts`.
 *
 * The two differences from the single-file conversion upload:
 *
 *   - More than one file, under one field name (`files`), because merging and
 *     scanning are inherently multi-document operations.
 *   - The accepted extension is fixed per middleware (`.pdf`, or one of the
 *     image types) rather than looked up in the conversion matrix - these
 *     endpoints are not part of it, and `isAllowedExtension` would wrongly
 *     accept a `.docx` here.
 *
 * Filenames on disk are `file-<index>.<ext>`, server-generated exactly as the
 * conversion upload's are and for the same reason: the client's own filename
 * never becomes a path.
 */
import { extname } from 'node:path';

import multer from 'multer';

import { MAX_PAGE_OPERATION_FILES, MAX_UPLOAD_BYTES } from '../config.ts';
import { Errors } from '../errors.ts';
import { getContext } from './request-context.ts';

const FIELD_NAME = 'files';

function createFilesUploadMiddleware(options: {
  extensions: readonly string[];
  unsupportedMessage: string;
  maxCount: number;
}) {
  const { extensions, unsupportedMessage, maxCount } = options;

  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const ctx = getContext(req);
        if (!ctx.workspace) {
          cb(Errors.internal('workspace missing before upload'), '');
          return;
        }
        cb(null, ctx.workspace);
      },
      filename: (req, file, cb) => {
        const ctx = getContext(req);
        // `req.files` is not populated until multer finishes, so the index has
        // to be tracked by hand as each part arrives, in the order it arrives.
        const index = ctx.uploadedFileCount ?? 0;
        ctx.uploadedFileCount = index + 1;
        cb(null, `file-${index}${extname(file.originalname ?? '').toLowerCase()}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: maxCount },
    fileFilter: (_req, file, cb) => {
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (!extensions.includes(extension)) {
        cb(Errors.unsupported(unsupportedMessage));
        return;
      }
      cb(null, true);
    },
  }).array(FIELD_NAME, maxCount);
}

/** `.pdf` only - `/pdf/merge`. */
export function createPdfFilesUploadMiddleware() {
  return createFilesUploadMiddleware({
    extensions: ['.pdf'],
    unsupportedMessage: 'Only .pdf files can be merged.',
    maxCount: MAX_PAGE_OPERATION_FILES,
  });
}

const SCAN_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

/** `.png`/`.jpg`/`.jpeg` only - `/pdf/scan-to-pdf`. */
export function createScanImagesUploadMiddleware() {
  return createFilesUploadMiddleware({
    extensions: SCAN_IMAGE_EXTENSIONS,
    unsupportedMessage: 'Only .png, .jpg and .jpeg images can be scanned to PDF.',
    maxCount: MAX_PAGE_OPERATION_FILES,
  });
}

/**
 * A single `.pdf` under the field name `file` - `/pdf/split`, `/pdf/
 * remove-pages`, `/pdf/extract-pages` and `/pdf/organize`, which each take
 * one document plus a page-selection field rather than several files.
 */
export function createSinglePdfUploadMiddleware() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const ctx = getContext(req);
        if (!ctx.workspace) {
          cb(Errors.internal('workspace missing before upload'), '');
          return;
        }
        cb(null, ctx.workspace);
      },
      filename: (_req, _file, cb) => cb(null, 'input.pdf'),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const extension = extname(file.originalname ?? '').toLowerCase();
      if (extension !== '.pdf') {
        cb(Errors.unsupported('Only .pdf files are accepted by this endpoint.'));
        return;
      }
      cb(null, true);
    },
  }).single('file');
}

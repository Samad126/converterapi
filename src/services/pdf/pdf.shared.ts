/**
 * Shared by every pdf-*.service.ts module: loading a PDF the same way
 * everywhere, so a corrupt/encrypted file fails identically no matter which
 * operation (pages, forms, sign, edit) touched it first.
 */
import { PDFDocument } from 'pdf-lib';

import { Errors } from '../../errors.ts';

/** A PDF that failed to load at all: encrypted (checked earlier), corrupt, or not really a PDF. */
export async function loadPdf(bytes: Buffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    throw Errors.convertFailed(error);
  }
}

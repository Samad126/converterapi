/**
 * Programmatic API: the same conversion pipeline the HTTP server and the
 * `converter` CLI use, without either of them.
 *
 * The engines (LibreOffice, pandoc, ffmpeg, qpdf, ...) are system tools, not
 * npm dependencies - run `npx converter doctor` to see which are installed.
 * `CONVERT_TIMEOUT_MS` is read once when this module is first imported, so set
 * it before importing if the 90s default is too short.
 */
import fsp from 'node:fs/promises';
import { extname, join } from 'node:path';

import { isAllowedExtension, isTargetId, resolveConversion, targetsFor, type TargetId } from './formats.ts';
import { convert, type ConversionResult } from './pipelines/conversion.pipeline.ts';
import { createWorkspace, inputFileNameFor, removeWorkspace } from './services/workspace.service.ts';

export { isTargetId, targetsFor, TARGETS, SOURCES } from './formats.ts';
export type { TargetId } from './formats.ts';
export { AppError } from './errors.ts';
export type { ConversionResult, ProducedFile } from './pipelines/conversion.pipeline.ts';

export interface ConvertFileOptions {
  /** Target format id, e.g. `pdf`, `png`, `docx`. See `TARGETS`. */
  to: TargetId;
  /** Required when `input` is a Buffer; taken from the path otherwise. e.g. `.docx` */
  extension?: string;
  /** Scanned-PDF OCR for PDF -> docx. Defaults to true. */
  ocr?: boolean;
  signal?: AbortSignal;
}

/**
 * Converts a file path or a Buffer to `options.to`.
 * Rejects with a plain Error for unsupported input/target pairs and with an
 * `AppError` when an engine fails (a missing engine shows as `ENOENT` in `cause`).
 */
export async function convertFile(input: string | Buffer, options: ConvertFileOptions): Promise<ConversionResult> {
  const raw = typeof input === 'string' ? extname(input) : (options.extension ?? '');
  const extension = (raw.startsWith('.') || raw === '' ? raw : `.${raw}`).toLowerCase();

  if (!isTargetId(options.to)) throw new Error(`Unknown target "${options.to}".`);
  if (!isAllowedExtension(extension)) {
    throw new Error(`Unsupported input extension "${extension || '<none>'}".`);
  }
  const conversion = resolveConversion(extension, options.to);
  if (!conversion) {
    throw new Error(`${extension} cannot become ${options.to}. It can become: ${targetsFor(extension).join(', ')}`);
  }

  const data = typeof input === 'string' ? await fsp.readFile(input) : input;
  if (data.length === 0) throw new Error('Input is empty.');

  const workspace = await createWorkspace();
  try {
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.writeFile(join(workspace, inputFileNameFor(extension)), data);
    return await convert({ workspace, conversion, ocr: options.ocr, signal: options.signal });
  } finally {
    await removeWorkspace(workspace);
  }
}

/** PDF page/security tools: `import { pdf } from 'any-file-converter'; await pdf.merge([a, b])`. */
export * as pdf from './pdf.ts';

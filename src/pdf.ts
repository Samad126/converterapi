/**
 * Programmatic PDF tools: the library twin of `converter pdf <op>`.
 *
 * Every function takes a path or a Buffer and resolves to a Buffer (`split`
 * to a Buffer[]). `pages` is 1-based, either a selection string
 * (`"1,3,5-7"`, same syntax as the CLI/HTTP API) or an array of numbers.
 * `protect`/`unlock`/`repair`/`compress` need `qpdf` on PATH; the rest are pure JS.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { compressWithQpdf, protectWithQpdf, repairWithQpdf, unlockWithQpdf, type CompressLevel } from './engines/qpdf.engine.ts';
import type { ProcessOutcome } from './engines/soffice.engine.ts';
import { Errors } from './errors.ts';
import { isPermutationOfAllPages, parsePageSelection } from './lib/page-ranges.ts';
import {
  addPageNumbers,
  addWatermark,
  cropPages,
  imagesToPdf,
  mergePdfs,
  pdfPageCount,
  removePages,
  rotatePages,
  selectPages,
  splitPdf,
  type CropMargins,
  type PageNumberPosition,
} from './services/pdf-pages.service.ts';
import { editPdf, type EditElement, type EditImage } from './services/pdf/pdf-edit.service.ts';
import { fillForm, listFormFields, type FormFieldSummary, type FormFieldValue } from './services/pdf/pdf-forms.service.ts';
import { signPdf, type SignElement, type SignImage } from './services/pdf/pdf-sign.service.ts';
import { createWorkspace, removeWorkspace } from './services/workspace.service.ts';

export type PdfInput = string | Buffer;
export type PageSelection = string | readonly number[];
export type { EditElement, EditImage, FormFieldSummary, FormFieldValue, SignElement, SignImage };
export type { CompressLevel, CropMargins, PageNumberPosition };

async function load(input: PdfInput): Promise<Buffer> {
  const data = typeof input === 'string' ? await fsp.readFile(input) : input;
  if (data.length === 0) throw new Error('PDF input is empty.');
  return data;
}

async function indicesOf(pages: PageSelection | undefined, buffer: Buffer): Promise<number[] | undefined> {
  if (pages === undefined) return undefined;
  const spec = typeof pages === 'string' ? pages : pages.join(',');
  return parsePageSelection(spec, await pdfPageCount(buffer));
}

async function requirePages(pages: PageSelection, buffer: Buffer): Promise<number[]> {
  return (await indicesOf(pages, buffer))!;
}

/** Joins PDFs in the order given. */
export async function merge(inputs: readonly PdfInput[]): Promise<Buffer> {
  if (inputs.length < 2) throw new Error('merge needs at least two PDFs.');
  return mergePdfs(await Promise.all(inputs.map(load)));
}

/** Splits into parts of `every` pages (default 1). */
export async function split(input: PdfInput, options: { every?: number } = {}): Promise<Buffer[]> {
  const every = options.every ?? 1;
  if (!Number.isInteger(every) || every < 1) throw new Error('every must be a positive whole number.');
  return splitPdf(await load(input), every);
}

/** Keeps only `pages`. */
export async function extractPages(input: PdfInput, pages: PageSelection): Promise<Buffer> {
  const buffer = await load(input);
  return selectPages(buffer, await requirePages(pages, buffer));
}

/** Drops `pages`. */
export async function removePagesFrom(input: PdfInput, pages: PageSelection): Promise<Buffer> {
  const buffer = await load(input);
  return removePages(buffer, new Set(await requirePages(pages, buffer)));
}

/** Reorders: `order` must name every page exactly once. */
export async function organize(input: PdfInput, order: PageSelection): Promise<Buffer> {
  const buffer = await load(input);
  const indices = await requirePages(order, buffer);
  const count = await pdfPageCount(buffer);
  if (!isPermutationOfAllPages(indices, count)) {
    throw Errors.badPageRange(`The order must name every page exactly once (1-${count}).`);
  }
  return selectPages(buffer, indices);
}

/** One PDF page per image (`.png` or `.jpg`), like a scan. */
export async function scanToPdf(images: readonly { data: Buffer; format: 'png' | 'jpg' }[]): Promise<Buffer> {
  if (images.length < 1) throw new Error('scanToPdf needs at least one image.');
  return imagesToPdf(images);
}

export async function rotate(input: PdfInput, options: { degrees: 90 | 180 | 270 | -90 | -180 | -270; pages?: PageSelection }): Promise<Buffer> {
  if (![90, 180, 270, -90, -180, -270].includes(options.degrees)) {
    throw new Error('degrees must be one of 90, 180, 270, -90, -180, -270.');
  }
  const buffer = await load(input);
  return rotatePages(buffer, options.degrees, await indicesOf(options.pages, buffer));
}

export async function watermark(input: PdfInput, options: { text: string; pages?: PageSelection }): Promise<Buffer> {
  const buffer = await load(input);
  return addWatermark(buffer, options.text, await indicesOf(options.pages, buffer));
}

/** Margins are in PDF points (72 = 1 inch). */
export async function crop(input: PdfInput, options: Partial<CropMargins> & { pages?: PageSelection }): Promise<Buffer> {
  const buffer = await load(input);
  const { left = 0, right = 0, top = 0, bottom = 0 } = options;
  return cropPages(buffer, { left, right, top, bottom }, await indicesOf(options.pages, buffer));
}

export async function pageNumbers(input: PdfInput, options: { position?: PageNumberPosition; startAt?: number } = {}): Promise<Buffer> {
  return addPageNumbers(await load(input), { position: options.position ?? 'bottom-center', startAt: options.startAt ?? 1 });
}

type QpdfOp = 'protect' | 'unlock' | 'repair' | 'compress';

async function runQpdf(input: PdfInput, op: QpdfOp, extra: { password?: string; level?: CompressLevel } = {}): Promise<Buffer> {
  const data = await load(input);
  const workspace = await createWorkspace();
  try {
    await fsp.mkdir(workspace, { recursive: true });
    const inputPath = join(workspace, 'input.pdf');
    const outputPath = join(workspace, 'output.pdf');
    await fsp.writeFile(inputPath, data);
    const base = { inputPath, outputPath, workspace, deadline: Date.now() + 1000 * 60 * 30 };

    let outcome: ProcessOutcome;
    if (op === 'protect') outcome = await protectWithQpdf({ ...base, password: extra.password! });
    else if (op === 'unlock') outcome = await unlockWithQpdf({ ...base, password: extra.password! });
    else if (op === 'repair') outcome = await repairWithQpdf(base);
    else outcome = await compressWithQpdf({ ...base, level: extra.level });

    const acceptable = op === 'repair' ? [0, 3] : [0];
    if (outcome.kind === 'timeout') throw Errors.timeout();
    if (outcome.kind === 'aborted') throw new Error('cancelled');
    if (outcome.kind === 'exited' && !acceptable.includes(outcome.exitCode ?? -1)) {
      if (op === 'unlock' && /invalid password/i.test(outcome.stderr)) throw Errors.wrongPassword();
      throw Errors.convertFailed(outcome.stderr || `qpdf exited ${outcome.exitCode}`);
    }
    const result = await fsp.readFile(outputPath);
    if (result.length === 0) throw Errors.convertFailed('qpdf produced an empty file');
    return result;
  } finally {
    await removeWorkspace(workspace);
  }
}

export function protect(input: PdfInput, options: { password: string }): Promise<Buffer> {
  if (!options.password) throw new Error('password is required.');
  return runQpdf(input, 'protect', options);
}

export function unlock(input: PdfInput, options: { password: string }): Promise<Buffer> {
  if (!options.password) throw new Error('password is required.');
  return runQpdf(input, 'unlock', options);
}

export function repair(input: PdfInput): Promise<Buffer> {
  return runQpdf(input, 'repair');
}

export function compress(input: PdfInput, options: { level?: CompressLevel } = {}): Promise<Buffer> {
  return runQpdf(input, 'compress', options);
}

/**
 * Draws signatures, initials, stamps, names, dates or text onto pages. Element
 * coordinates are points from the page's top-left; `page` is 1-based. Images
 * are referenced by `imageIndex`.
 */
export async function sign(input: PdfInput, options: { elements: readonly SignElement[]; images?: readonly SignImage[] }): Promise<Buffer> {
  return signPdf(await load(input), options.elements, options.images ?? []);
}

/** Draws text, images, rectangles, ellipses, lines and freehand strokes onto pages. Same coordinates as `sign`. */
export async function edit(input: PdfInput, options: { elements: readonly EditElement[]; images?: readonly EditImage[] }): Promise<Buffer> {
  return editPdf(await load(input), options.elements, options.images ?? []);
}

/** Lists the fillable (AcroForm) fields in a PDF. */
export async function formFields(input: PdfInput): Promise<FormFieldSummary[]> {
  return listFormFields(await load(input));
}

/** Fills named form fields; `flatten: true` bakes the values into the page. */
export async function fillFormFields(
  input: PdfInput,
  values: Readonly<Record<string, FormFieldValue>>,
  options: { flatten?: boolean } = {},
): Promise<Buffer> {
  return fillForm(await load(input), values, options);
}

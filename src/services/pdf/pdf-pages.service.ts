/**
 * Page-level PDF operations: merge, split, remove, extract, reorder, rotate,
 * watermark, crop, page numbers, and building a PDF from a set of images
 * ("scan to PDF").
 *
 * Unlike every other pipeline in this service, none of this touches
 * LibreOffice or `pdf_engine.py` - there is no document conversion happening
 * at all, just moving pages (or whole images) between PDF structures. That is
 * exactly what `pdf-lib` is for, and it runs in-process, synchronously with
 * respect to the event loop for anything this size: no subprocess, no
 * deadline, no profile directory. The closest relative in this codebase is
 * the `tables`/`layers` extractors, for the same reason - the work is ours,
 * not LibreOffice's.
 *
 * Every function here loads its own `PDFDocument` from the bytes it is given
 * rather than sharing one loaded upstream. That means a request whose
 * controller also needed the page count (to validate a `pages`/`order` field
 * before calling here) parses the PDF twice - accepted for the sake of a
 * service whose functions each take plain bytes in and plain bytes out,
 * rather than threading a loaded `PDFDocument` through the controller layer.
 * Uploads are capped at 100MB (`MAX_UPLOAD_BYTES`), so the second parse is
 * bounded, not unbounded rework.
 */
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

import { Errors } from '../../errors.ts';
import { loadPdf } from './pdf.shared.ts';

/** How many pages a PDF has, without doing anything else to it. */
export async function pdfPageCount(bytes: Buffer): Promise<number> {
  const document = await loadPdf(bytes);
  return document.getPageCount();
}

/** Build a new PDF from an ordered list of 0-based page indices into `bytes`. */
async function buildFromIndices(bytes: Buffer, indices: readonly number[]): Promise<Buffer> {
  const source = await loadPdf(bytes);
  const output = await PDFDocument.create();
  const pages = await output.copyPages(source, indices as number[]);
  for (const page of pages) output.addPage(page);
  return Buffer.from(await output.save());
}

/**
 * Every page of every PDF, concatenated in the order the files were uploaded.
 *
 * Deliberately not deduplicating or otherwise second-guessing the input: two
 * copies of the same file merge into two copies of its pages, because that is
 * what "merge these files, in this order" means.
 */
export async function mergePdfs(files: readonly Buffer[]): Promise<Buffer> {
  const output = await PDFDocument.create();
  for (const bytes of files) {
    const source = await loadPdf(bytes);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  return Buffer.from(await output.save());
}

/**
 * One PDF, cut into consecutive chunks of `pagesPerPart` pages each.
 *
 * The last chunk is whatever is left over, which is why this is not simply
 * `Math.ceil(total / pagesPerPart)` chunks of an even size - a 7-page
 * document split every 3 pages is 3, 3, 1, not three equal parts.
 */
export async function splitPdf(bytes: Buffer, pagesPerPart: number): Promise<Buffer[]> {
  const source = await loadPdf(bytes);
  const total = source.getPageCount();
  const parts: Buffer[] = [];

  for (let start = 0; start < total; start += pagesPerPart) {
    const end = Math.min(start + pagesPerPart, total);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source, indices);
    for (const page of pages) output.addPage(page);
    parts.push(Buffer.from(await output.save()));
  }

  return parts;
}

/**
 * A new PDF holding exactly the given pages, in the given order.
 *
 * The one operation behind both `/pdf/extract-pages` and `/pdf/organize` -
 * the two endpoints differ only in what they require of `indices` before
 * calling this (a subset versus a true permutation), not in what they do
 * with it once it is validated. See the controller.
 */
export async function selectPages(bytes: Buffer, indices: readonly number[]): Promise<Buffer> {
  return buildFromIndices(bytes, indices);
}

/**
 * A new PDF with the named 0-based pages removed, everything else kept in its
 * original order.
 *
 * The complement of `selectPages`: rather than asking the caller to compute
 * "every page except these," this takes the removal set directly, because
 * that is what a person filling in "which pages do you want to remove" typed.
 */
export async function removePages(bytes: Buffer, toRemove: ReadonlySet<number>): Promise<Buffer> {
  const source = await loadPdf(bytes);
  const keep = source.getPageIndices().filter((index) => !toRemove.has(index));
  if (keep.length === 0) {
    throw Errors.badPageRange('Removing these pages would leave the document empty.');
  }
  const output = await PDFDocument.create();
  const pages = await output.copyPages(source, keep);
  for (const page of pages) output.addPage(page);
  return Buffer.from(await output.save());
}

/**
 * Rotate the named 0-based pages (or every page, if `indices` is omitted) by
 * `delta` degrees clockwise, added to whatever rotation the page already
 * carries rather than replacing it - a page already rotated 90 by its source
 * document and then rotated another 90 here should end up at 180, not back
 * at 90.
 *
 * `delta` is validated by the caller to be a multiple of 90: the PDF
 * `/Rotate` entry is only ever defined for multiples of 90, and pdf-lib
 * itself does not stop you from setting something else.
 */
export async function rotatePages(
  bytes: Buffer,
  delta: number,
  indices?: readonly number[],
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const targets = indices ?? document.getPageIndices();
  for (const index of targets) {
    const page = document.getPage(index);
    const current = page.getRotation().angle;
    page.setRotation(degrees(((current + delta) % 360 + 360) % 360));
  }
  return Buffer.from(await document.save());
}

/**
 * Stamp `text` centered across the named 0-based pages (or every page),
 * semi-transparent and behind nothing - there is no page content to stack it
 * under, so "behind" is not a meaningful option here the way it is in an
 * editor that already has layers.
 *
 * Drawn horizontally rather than at a diagonal: a rotated run of text is
 * exactly as visible to a reader, but text renderers (poppler's `pdftotext`
 * among them) commonly fall back to one character per line for rotated
 * glyph runs, which would make an otherwise ordinary stamp far harder for
 * downstream tooling to get right for no visual benefit.
 *
 * Sized as a fraction of each page's own dimensions rather than a fixed
 * point size, because a scanned receipt and an A3 poster are both real
 * inputs to this endpoint and a fixed size is either invisible on one or
 * absurd on the other.
 */
export async function addWatermark(
  bytes: Buffer,
  text: string,
  indices?: readonly number[],
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  const targets = indices ?? document.getPageIndices();

  for (const index of targets) {
    const page = document.getPage(index);
    const { width, height } = page.getSize();
    const fontSize = Math.max(8, Math.min(width, height) * 0.12);
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height * 0.1,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity: 0.45,
    });
  }

  return Buffer.from(await document.save());
}

export interface CropMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Trim `margins` (in points) off each edge of the named 0-based pages (or
 * every page), by shrinking the crop box rather than touching the page
 * content - the trimmed area still exists in the file, it is simply outside
 * what a viewer shows or a printer prints, which is what "crop" means for a
 * PDF as opposed to a raster image.
 *
 * Validated by the caller against each page's own size: a margin larger than
 * the page is not a smaller page, it is an inside-out one.
 */
export async function cropPages(
  bytes: Buffer,
  margins: CropMargins,
  indices?: readonly number[],
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const targets = indices ?? document.getPageIndices();

  for (const index of targets) {
    const page = document.getPage(index);
    const box = page.getMediaBox();
    const width = box.width - margins.left - margins.right;
    const height = box.height - margins.top - margins.bottom;
    if (width <= 0 || height <= 0) {
      throw Errors.invalidField(
        `Cropping page ${index + 1} by these margins would leave nothing: it is ${box.width}x${box.height}pt.`,
      );
    }
    page.setCropBox(box.x + margins.left, box.y + margins.bottom, width, height);
  }

  return Buffer.from(await document.save());
}

export type PageNumberPosition = 'bottom-center' | 'bottom-right' | 'bottom-left';

/**
 * Draw `<startAt + i>` on each page in order, starting from the first of the
 * named 0-based pages (or the very first page) - there is no "skip these
 * pages but keep counting" mode, because a page number that disagrees with
 * its own position in the document is the one thing this feature must never
 * produce.
 */
export async function addPageNumbers(
  bytes: Buffer,
  options: { position: PageNumberPosition; startAt: number },
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const margin = 24;

  document.getPages().forEach((page, i) => {
    const label = String(options.startAt + i);
    const { width } = page.getSize();
    const fontSize = 10;
    const textWidth = font.widthOfTextAtSize(label, fontSize);

    const x =
      options.position === 'bottom-left'
        ? margin
        : options.position === 'bottom-right'
          ? width - margin - textWidth
          : width / 2 - textWidth / 2;

    page.drawText(label, { x, y: margin / 2, size: fontSize, font, color: rgb(0.3, 0.3, 0.3) });
  });

  return Buffer.from(await document.save());
}

export type ScanImageFormat = 'png' | 'jpg';

export interface ScanImage {
  data: Buffer;
  format: ScanImageFormat;
}

/**
 * One PDF, one page per image, each page sized to that image's own pixel
 * dimensions - which is what makes this "a scan" rather than a slideshow:
 * there is no fixed page size imposed on a photo taken in portrait next to
 * one taken in landscape.
 */
export async function imagesToPdf(images: readonly ScanImage[]): Promise<Buffer> {
  const document = await PDFDocument.create();

  for (const image of images) {
    let embedded;
    try {
      embedded = image.format === 'png' ? await document.embedPng(image.data) : await document.embedJpg(image.data);
    } catch (error) {
      throw Errors.convertFailed(error);
    }
    const page = document.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }

  return Buffer.from(await document.save());
}

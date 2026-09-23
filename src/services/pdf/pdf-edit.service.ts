/**
 * General-purpose PDF markup for `/pdf/edit`: text, images, rectangles,
 * ellipses, lines and freehand strokes at caller-given positions. Split out
 * of pdf-pages.service.ts as its own domain - the general-purpose sibling of
 * `pdf-sign.service.ts`'s fixed set of signature-shaped marks.
 */
import { StandardFonts, rgb, type PDFImage } from 'pdf-lib';

import { Errors } from '../../errors.ts';
import { loadPdf } from './pdf.shared.ts';

export type EditElementType = 'text' | 'image' | 'rectangle' | 'ellipse' | 'line' | 'freehand';
export type EditColor = 'black' | 'red' | 'blue' | 'green' | 'yellow' | 'orange';

export interface EditPoint {
  x: number;
  y: number;
}

/**
 * One mark for `/pdf/edit`, already fully validated by the controller: `page`
 * is a real 1-based page number, `imageIndex` (for `type: "image"`) already
 * points at an uploaded image, and every field a given `type` needs is
 * present - see `parseEditElement`'s doc comment for exactly which fields
 * that is per type. This function's job is drawing, not re-checking a
 * contract the caller already checked, the same division `signPdf` above
 * keeps.
 *
 * Unlike `SignElement`, which is a box a signature/stamp is centered and
 * sized into, `EditElement`'s geometry follows what each shape actually
 * needs: a box (`x`/`y`/`width`/`height`) for `text`/`image`/`rectangle`/
 * `ellipse`, two endpoints (`x1`/`y1`/`x2`/`y2`) for `line`, and a point list
 * for `freehand` - there is no one geometry every mark on a general-purpose
 * editor shares.
 */
export interface EditElement {
  type: EditElementType;
  /** 1-based, top-to-bottom - the page this element is drawn on. */
  page: number;
  color?: EditColor;
  /** Outline/stroke width in points, for `rectangle`/`ellipse`/`line`/`freehand`. */
  strokeWidth?: number;
  /** `rectangle`/`ellipse` only: filled with `color` rather than just outlined. */
  fill?: boolean;
  /** `text` only. */
  value?: string;
  /** `text` only, in points. */
  fontSize?: number;
  /** Top-left origin, in points: (0,0) is the page's top-left corner. */
  x?: number;
  y?: number;
  /** `image`/`rectangle`/`ellipse` only. */
  width?: number;
  height?: number;
  /** `image` only: index into the uploaded `images` files. */
  imageIndex?: number;
  /** `line` only - both endpoints, top-left origin. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** `freehand` only: the path, in the order it was drawn, top-left origin. */
  points?: readonly EditPoint[];
}

export interface EditImage {
  data: Buffer;
  format: 'png' | 'jpg';
}

/**
 * Named-color -> RGB, the same plain-ink-color spirit `SIGN_TEXT_COLORS`
 * uses, extended with yellow/orange for highlighting and callouts - marks a
 * general-purpose editor draws that a signature stamp never needed.
 */
const EDIT_COLORS: Record<EditColor, readonly [number, number, number]> = {
  black: [0.05, 0.05, 0.05],
  red: [0.75, 0.08, 0.08],
  blue: [0.09, 0.25, 0.7],
  green: [0.08, 0.5, 0.18],
  yellow: [0.85, 0.7, 0.05],
  orange: [0.85, 0.45, 0.05],
};

/**
 * Bake `elements` permanently into `bytes`'s page content and return the
 * result - text, images, rectangles, ellipses, lines and freehand strokes at
 * caller-given positions, the general-purpose sibling of `signPdf`'s fixed
 * set of signature-shaped marks. Drawn as page content, not annotations, for
 * the same reason `signPdf` does: a permanent mark, not something meant to
 * remain editable after the document is downloaded.
 *
 * **Coordinate flip**: every position on `EditElement` is top-left origin
 * (0,0 at the page's top-left corner, y increasing downward), the natural
 * system a browser `<canvas>` overlay reports - `signPdf`'s doc comment
 * derives the exact arithmetic this reuses per shape.
 */
export async function editPdf(
  bytes: Buffer,
  elements: readonly EditElement[],
  images: readonly EditImage[],
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Embedding is per-image, not per-element, for the same reason `signPdf`
  // caches it: two elements referencing the same `imageIndex` should embed
  // that image's bytes into the PDF exactly once.
  const embeddedImages = new Map<number, PDFImage>();

  async function embeddedImageFor(imageIndex: number): Promise<PDFImage> {
    const cached = embeddedImages.get(imageIndex);
    if (cached) return cached;
    const image = images[imageIndex];
    if (!image) {
      throw Errors.internal(`edit element referenced images[${imageIndex}], which was not uploaded`);
    }
    let embedded: PDFImage;
    try {
      embedded = image.format === 'png' ? await document.embedPng(image.data) : await document.embedJpg(image.data);
    } catch (error) {
      throw Errors.convertFailed(error);
    }
    embeddedImages.set(imageIndex, embedded);
    return embedded;
  }

  for (const element of elements) {
    const page = document.getPage(element.page - 1);
    const { height: pageHeight } = page.getSize();
    const [r, g, b] = EDIT_COLORS[element.color ?? 'black'];
    const color = rgb(r, g, b);
    const strokeWidth = element.strokeWidth ?? 2;

    switch (element.type) {
      case 'text': {
        const size = element.fontSize ?? 14;
        page.drawText(element.value ?? '', {
          x: element.x!,
          // Anchored by the box's TOP, unlike `signPdf`'s box-fit text: a
          // general editor places text at a point the caller chose, not a
          // box sized around it, so there is no width to center within.
          y: pageHeight - element.y! - size,
          size,
          font,
          color,
        });
        break;
      }
      case 'image': {
        const embedded = await embeddedImageFor(element.imageIndex!);
        page.drawImage(embedded, {
          x: element.x!,
          y: pageHeight - element.y! - element.height!,
          width: element.width!,
          height: element.height!,
        });
        break;
      }
      case 'rectangle': {
        page.drawRectangle({
          x: element.x!,
          y: pageHeight - element.y! - element.height!,
          width: element.width!,
          height: element.height!,
          borderWidth: strokeWidth,
          borderColor: color,
          color: element.fill ? color : undefined,
        });
        break;
      }
      case 'ellipse': {
        page.drawEllipse({
          x: element.x! + element.width! / 2,
          y: pageHeight - element.y! - element.height! / 2,
          xScale: element.width! / 2,
          yScale: element.height! / 2,
          borderWidth: strokeWidth,
          borderColor: color,
          color: element.fill ? color : undefined,
        });
        break;
      }
      case 'line': {
        page.drawLine({
          start: { x: element.x1!, y: pageHeight - element.y1! },
          end: { x: element.x2!, y: pageHeight - element.y2! },
          thickness: strokeWidth,
          color,
        });
        break;
      }
      case 'freehand': {
        // A polyline through every point, in order - piecewise-straight
        // rather than a fitted curve, which is close enough for a stroke
        // sampled from mouse/touch movement at any reasonable rate and
        // needs no curve-fitting step pdf-lib has no built-in support for.
        const points = element.points!;
        for (let i = 0; i < points.length - 1; i += 1) {
          page.drawLine({
            start: { x: points[i]!.x, y: pageHeight - points[i]!.y },
            end: { x: points[i + 1]!.x, y: pageHeight - points[i + 1]!.y },
            thickness: strokeWidth,
            color,
          });
        }
        break;
      }
    }
  }

  return Buffer.from(await document.save());
}

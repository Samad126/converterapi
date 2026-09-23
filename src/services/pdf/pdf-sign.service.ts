/**
 * The visual-only "simple signature" stamp for `/pdf/sign`. Split out of
 * pdf-pages.service.ts as its own domain - fixed signature-shaped element
 * types and dedicated fonts, distinct from `pdf-edit.service.ts`'s
 * general-purpose drawing.
 */
import fontkit from '@pdf-lib/fontkit';
import { rgb, StandardFonts, type PDFDocument, type PDFFont, type PDFImage } from 'pdf-lib';

import { Errors } from '../../errors.ts';
import { dancingScriptFontBytes } from '../signature-fonts.ts';
import { loadPdf } from './pdf.shared.ts';

export type SignElementType = 'signature' | 'initials' | 'stamp' | 'name' | 'date' | 'text';
export type SignFontStyle = 'cursive' | 'cursive2' | 'plain';
export type SignColor = 'black' | 'red' | 'blue' | 'green';

/**
 * One placed mark for `/pdf/sign`, already fully validated by the controller
 * (`page` is a real 1-based page number, `imageIndex` if present already
 * points at an uploaded image, exactly one of `value`/`imageIndex` is set
 * per the type-specific rule the controller enforces) - this function's job
 * is drawing, not re-checking a contract the caller already checked.
 */
export interface SignElement {
  type: SignElementType;
  /** 1-based, top-to-bottom - the page this element is drawn on. */
  page: number;
  /** Top-left origin, in points: (0,0) is the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Typed text - set for "name"/"date"/"text" always, and for a typed signature/initials. */
  value?: string;
  /** Index into `images` - set for "stamp" always, and for a drawn/uploaded signature/initials. */
  imageIndex?: number;
  fontStyle?: SignFontStyle;
  color?: SignColor;
}

export interface SignImage {
  data: Buffer;
  format: 'png' | 'jpg';
}

/**
 * Named-color -> RGB for text-rendered sign elements (typed signature/
 * initials, name, date, text). Picked as plain, unambiguous ink colors
 * rather than desaturated "brand" shades: this is a stamp meant to be read
 * as a signature, not a UI accent, and a person choosing "red" expects red.
 */
const SIGN_TEXT_COLORS: Record<SignColor, readonly [number, number, number]> = {
  black: [0.05, 0.05, 0.05],
  red: [0.75, 0.08, 0.08],
  blue: [0.09, 0.25, 0.7],
  green: [0.08, 0.5, 0.18],
};

/**
 * The three fonts `signPdf` ever draws with, embedded once per document:
 *
 *   - `plain` (Helvetica) for "name"/"date"/"text", which always render
 *     plain regardless of `fontStyle` - the field description says so
 *     explicitly, because a form-filled name in a script font would look
 *     like a joke, not a signature.
 *   - `cursive` (embedded Dancing Script, see `signature-fonts.ts`) - the
 *     default look for a typed signature/initials.
 *   - `cursive2` (pdf-lib's own `HelveticaBoldOblique`) - a second, visually
 *     distinct "print-style signature" option that costs no extra asset or
 *     license file; see `signature-fonts.ts` for why this is not a second
 *     downloaded script font.
 */
interface SignFonts {
  plain: PDFFont;
  cursive: PDFFont;
  cursive2: PDFFont;
}

async function embedSignFonts(document: PDFDocument): Promise<SignFonts> {
  document.registerFontkit(fontkit);
  const [plain, cursive, cursive2] = await Promise.all([
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(await dancingScriptFontBytes()),
    document.embedFont(StandardFonts.HelveticaBoldOblique),
  ]);
  return { plain, cursive, cursive2 };
}

function fontFor(element: SignElement, fonts: SignFonts): PDFFont {
  if (element.type === 'name' || element.type === 'date' || element.type === 'text') return fonts.plain;
  if (element.fontStyle === 'plain') return fonts.plain;
  if (element.fontStyle === 'cursive2') return fonts.cursive2;
  return fonts.cursive;
}

/**
 * The largest font size (in points) that fits `text` inside a `boxWidth` x
 * `boxHeight` box, the same "size to the space available" spirit `addWater-
 * mark` uses for a page-sized stamp - a fixed size would either overflow a
 * small "Initials" box or look lost in a large "Signature" one.
 *
 * Height bounds the starting guess (a script font's tall ascenders/
 * descenders mean using the full box height overflows it, hence the 0.7
 * fudge factor); width is then enforced exactly by shrinking one point at a
 * time until `font.widthOfTextAtSize` fits within it, since pdf-lib has no
 * built-in text-fitting helper.
 */
function fitFontSize(font: PDFFont, text: string, boxWidth: number, boxHeight: number): number {
  let size = Math.min(48, Math.max(6, boxHeight * 0.7));
  while (size > 6 && font.widthOfTextAtSize(text, size) > boxWidth * 0.95) {
    size -= 1;
  }
  return size;
}

/**
 * Bake `elements` permanently into `bytes`'s page content and return the
 * result - the visual-only "simple signature" stamp, NOT cryptographic PDF
 * signing (no certificate, no `/AcroForm`/`/Sig` dictionary, nothing an eIDAS/
 * ESIGN/UETA-style verifier would recognise as a digital signature). Real
 * signing is out of scope pending a certificate/key-management decision this
 * codebase has not made yet; this only draws text or an image onto the page,
 * the same as `addWatermark`/`addPageNumbers` do, generalized to caller-given
 * positions and several element types instead of one fixed formula.
 *
 * Elements are drawn as page content, not AcroForm fields, on purpose: this
 * is a permanent mark, not something meant to remain editable after the
 * document is downloaded.
 *
 * **Coordinate flip**: `x`/`y` on `SignElement` are top-left origin (0,0 at
 * the page's top-left corner, y increasing downward) - the natural system a
 * browser `<canvas>` overlay reports mouse/drag positions in. pdf-lib's
 * `drawText`/`drawImage` use PDF's own bottom-left origin, where `y` is the
 * distance from the page's BOTTOM to the BOTTOM of what is drawn. For a page
 * of height `H` and an element of height `height` placed at top-left `y`,
 * the distance from the top to the element's bottom is `y + height`, so the
 * distance from the BOTTOM to that same edge - the `y` pdf-lib wants - is
 * `H - (y + height)`, i.e. `H - y - height`. Verified in `test/pages.test.ts`
 * by drawing at a known position and reading the position back rather than
 * trusting the arithmetic alone.
 */
export async function signPdf(
  bytes: Buffer,
  elements: readonly SignElement[],
  images: readonly SignImage[],
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  const fonts = await embedSignFonts(document);
  // Embedding is per-image, not per-element: two elements referencing the
  // same `imageIndex` (a "stamp" placed on two pages, say) should embed that
  // image's bytes into the PDF exactly once, not once per placement.
  const embeddedImages = new Map<number, PDFImage>();

  async function embeddedImageFor(imageIndex: number): Promise<PDFImage> {
    const cached = embeddedImages.get(imageIndex);
    if (cached) return cached;
    const image = images[imageIndex];
    if (!image) {
      // Already validated by the controller - reaching this means the
      // controller's own check drifted out of sync with this function.
      throw Errors.internal(`sign element referenced images[${imageIndex}], which was not uploaded`);
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
    const pdfY = pageHeight - element.y - element.height;

    if (element.imageIndex !== undefined) {
      const embedded = await embeddedImageFor(element.imageIndex);
      page.drawImage(embedded, { x: element.x, y: pdfY, width: element.width, height: element.height });
      continue;
    }

    const text = element.value ?? '';
    const font = fontFor(element, fonts);
    const [r, g, b] = SIGN_TEXT_COLORS[element.color ?? 'black'];
    const fontSize = fitFontSize(font, text, element.width, element.height);
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    page.drawText(text, {
      // Centered horizontally in the box; vertically centered using the
      // font size itself as a stand-in for its cap height, close enough for
      // a box the caller sized around the text it is placing.
      x: element.x + Math.max(0, (element.width - textWidth) / 2),
      y: pdfY + Math.max(0, (element.height - fontSize) / 2),
      size: fontSize,
      font,
      color: rgb(r, g, b),
    });
  }

  return Buffer.from(await document.save());
}

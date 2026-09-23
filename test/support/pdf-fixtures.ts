/** PDF fixtures shared by the /pdf/* integration tests. */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { pdfPageText } from './helpers.ts';

const { buildMinimalPdf } = await import('../../src/lib/probe-documents.ts');

/** Build a small real PDF whose AcroForm has one text field and one checkbox. */
export async function buildFormPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 150]);
  const form = document.getForm();

  const textField = form.createTextField('name');
  textField.setText('');
  textField.addToPage(page, { x: 20, y: 100, width: 150, height: 20 });

  const checkbox = form.createCheckBox('agree');
  checkbox.addToPage(page, { x: 20, y: 60, width: 20, height: 20 });

  return Buffer.from(await document.save());
}

/**
 * `pdftotext -bbox` (poppler-utils, already required) reports each word's
 * bounding box in an HTML/XML dump, in the SAME top-left-origin coordinate
 * system `/pdf/sign`'s `x`/`y`/`width`/`height` are specified in - which
 * makes it the tool for verifying the coordinate flip actually lands text
 * where a caller asked for it, rather than trusting the `H - y - height`
 * arithmetic in `signPdf` on faith.
 */
export async function pdfWordBoxes(
  pdf: Buffer,
  pageNumber: number,
): Promise<Array<{ word: string; xMin: number; yMin: number; xMax: number; yMax: number }>> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-sign-bbox-'));
  try {
    const inPath = join(dir, 'in.pdf');
    await fsp.writeFile(inPath, pdf);
    const xml = await new Promise<string>((resolve, reject) => {
      execFile(
        'pdftotext',
        ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), inPath, '-'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const boxes: Array<{ word: string; xMin: number; yMin: number; xMax: number; yMax: number }> = [];
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    for (const match of xml.matchAll(wordRe)) {
      boxes.push({
        xMin: Number(match[1]),
        yMin: Number(match[2]),
        xMax: Number(match[3]),
        yMax: Number(match[4]),
        word: match[5]!,
      });
    }
    return boxes;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A one-page, 300x300pt PDF with two well-separated, distinctly-named text
 * strings drawn via `pdf-lib`'s own `drawText` at known baseline positions -
 * `buildMinimalPdf` (used by every other test above) only supports a single
 * line per page at a fixed position, which is not enough control to reliably
 * target one piece of text with a redaction rectangle while leaving another
 * untouched. `pdf-lib` coordinates are bottom-left origin (y counts up from
 * the bottom), which is NOT what `/pdf/redact`'s API or its engine (PyMuPDF)
 * use - both are top-left origin - so this helper hands back each string's
 * bounding box already converted to top-left, ready to pass straight to
 * `/pdf/redact`'s `areas`.
 */
export async function buildRedactFixture(): Promise<{
  pdf: Buffer;
  pageHeight: number;
  secretBox: { x: number; y: number; width: number; height: number };
  keepBox: { x: number; y: number; width: number; height: number };
}> {
  const pageWidth = 300;
  const pageHeight = 300;
  const fontSize = 14;
  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidth, pageHeight]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const secretText = 'CLASSIFIEDSECRET';
  const keepText = 'PublicKeepThis';
  const secretBaselineY = 250; // near the top of the page, bottom-left-origin
  const keepBaselineY = 30; // near the bottom of the page, bottom-left-origin
  const x = 20;

  page.drawText(secretText, { x, y: secretBaselineY, size: fontSize, font });
  page.drawText(keepText, { x, y: keepBaselineY, size: fontSize, font });

  const secretWidth = font.widthOfTextAtSize(secretText, fontSize);
  const keepWidth = font.widthOfTextAtSize(keepText, fontSize);
  // A generous vertical pad around each baseline (ascender/descender room),
  // converted from pdf-lib's bottom-left y to the top-left y this endpoint's
  // `areas` field expects: topY = pageHeight - bottomY - boxHeight.
  const pad = 6;
  const boxHeight = fontSize + pad * 2;

  const secretBox = {
    x: x - 4,
    y: pageHeight - (secretBaselineY + fontSize + pad),
    width: secretWidth + 8,
    height: boxHeight,
  };
  const keepBox = {
    x: x - 4,
    y: pageHeight - (keepBaselineY + fontSize + pad),
    width: keepWidth + 8,
    height: boxHeight,
  };

  return { pdf: Buffer.from(await doc.save()), pageHeight, secretBox, keepBox };
}

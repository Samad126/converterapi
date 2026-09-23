/**
 * Refusing to boot into a service that cannot do its job.
 *
 * Every condition checked here fails SILENTLY if you skip it. A missing soffice
 * gives you a service that returns 500s; missing fonts give you something far
 * worse - a service that returns 200 with a PDF whose pagination disagrees with
 * Word. Nobody notices the second one until a customer does.
 *
 * Since the service became a universal converter, "can it do its job" is no
 * longer one question. A container with `libreoffice-writer` and nothing else
 * converts every Word document perfectly and fails every spreadsheet, so the
 * boot check has to exercise each family rather than just prove that soffice
 * exists. `warmUp()` (in `./preflight/warmup.service.ts`) is what does that,
 * by running one real conversion per pipeline - including the two-step
 * PDF-then-rasterise path for the Impress family, which is the only way a
 * missing poppler is ever noticed. The individual "can this binary even run"
 * checks live in `./preflight/preflight.checks.ts`; this file only
 * orchestrates them.
 */
import { TESSERACT_BIN } from '../config.ts';
import {
  assertArrowEnginePresent,
  assertAssimpPresent,
  assertEbookConvertPresent,
  assertFfmpegPresent,
  assertFontEnginePresent,
  assertHeifPresent,
  assertMetricCompatibleFonts,
  assertNotRoot,
  assertPandocPresent,
  assertPdfEnginePresent,
  assertQpdfPresent,
  assertRasterizerPresent,
  assertSevenZipPresent,
  assertSofficePresent,
  assertZstdPresent,
  checkTesseractPresent,
} from './preflight/preflight.checks.ts';

export { warmUp, type WarmUpCase, type WarmUpReport } from './preflight/warmup.service.ts';

export interface PreflightReport {
  sofficeVersion: string;
  rasterizerVersion: string;
  pandocVersion: string;
  sevenZipVersion: string;
  ffmpegVersion: string;
  heifConvertVersion: string;
  zstdVersion: string;
  assimpVersion: string;
  ebookConvertVersion: string;
  fonts: Array<{ requested: string; resolved: string }>;
  /** False means a scanned PDF's `docx` will convert without OCR - see `checkTesseractPresent`. */
  ocrAvailable: boolean;
}

export async function preflight(): Promise<PreflightReport> {
  assertNotRoot();
  const sofficeVersion = assertSofficePresent();
  const rasterizerVersion = assertRasterizerPresent();
  const fonts = assertMetricCompatibleFonts();
  assertPdfEnginePresent();
  assertQpdfPresent();
  const pandocVersion = assertPandocPresent();
  const sevenZipVersion = assertSevenZipPresent();
  const ffmpegVersion = assertFfmpegPresent();
  const heifConvertVersion = assertHeifPresent();
  const zstdVersion = assertZstdPresent();
  const assimpVersion = assertAssimpPresent();
  const ebookConvertVersion = assertEbookConvertPresent();
  assertFontEnginePresent();
  assertArrowEnginePresent();
  const ocrAvailable = checkTesseractPresent();
  if (!ocrAvailable) {
    console.warn(
      `tesseract (${TESSERACT_BIN}) is not available: a scanned PDF asking for docx will ` +
        'convert without OCR text. Install tesseract-ocr to enable it - see the Dockerfile.',
    );
  }
  return {
    sofficeVersion,
    rasterizerVersion,
    pandocVersion,
    sevenZipVersion,
    ffmpegVersion,
    heifConvertVersion,
    zstdVersion,
    assimpVersion,
    ebookConvertVersion,
    fonts,
    ocrAvailable,
  };
}

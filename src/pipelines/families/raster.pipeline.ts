/**
 * raster: pdf first, then one image per page.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_RASTER_PAGES, RASTER_DPI, RASTER_JPEG_QUALITY } from '../../config.ts';
import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { rasterizePdf, runSoffice } from '../../engines/soffice.engine.ts';
import { collectProducedFiles, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/** The images subdirectory, kept apart so collection is "everything in here". */
const RASTER_DIRNAME = 'raster';
/** pdftoppm writes `<prefix>-<page><ext>`. */
const RASTER_PREFIX = 'slide';

export async function runRasterPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  profileDir: string;
  target: TargetFormat;
  /** Is the upload already a PDF? Skips the render-to-PDF step below. */
  sourceIsPdf: boolean;
  /** The family's PDF export filter, resolved by the caller. */
  pdfFilter: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, profileDir, target, sourceIsPdf, pdfFilter, deadline, signal } =
    run;

  let intermediatePdfPath: string;
  if (sourceIsPdf) {
    // The upload already is the PDF this pipeline would otherwise spend a
    // soffice process rendering. Handing it straight to the rasteriser skips
    // a lossy round-trip through Draw for no benefit - the bytes on disk are
    // exactly what a PDF-to-image conversion should render.
    intermediatePdfPath = inputPath;
  } else {
    if (pdfFilter === '') {
      // Unreachable via the matrix, which refuses to advertise a raster target
      // for a source with no PDF export. Guarded anyway: the alternative is
      // handing soffice an empty filter argument and getting back whatever it
      // decides that means.
      throw Errors.internal(`no PDF export filter for the ${target.id} target`);
    }

    const render = await runSoffice({
      inputPath,
      outDir,
      profileDir,
      workspace,
      convertTo: `pdf:${pdfFilter}`,
      deadline,
      signal,
    });
    throwForOutcome(render);

    const pdf = await collectProducedFiles(outDir, '.pdf');
    const intermediate = pdf[0];
    if (!intermediate) {
      throw Errors.convertFailed(
        `soffice produced no intermediate PDF (exit=${render.exitCode} signal=${render.signal ?? 'none'} stderr=${render.stderr})`,
      );
    }
    intermediatePdfPath = join(outDir, intermediate.name);
  }

  // A private directory for the images, so "everything in here" is exactly the
  // pages and can be collected without filtering by filename.
  const rasterDir = join(workspace, RASTER_DIRNAME);
  await fsp.mkdir(rasterDir, { recursive: true });

  const format = target.id === 'png' ? 'png' : 'jpg';
  const raster = await rasterizePdf({
    pdfPath: intermediatePdfPath,
    outDir: rasterDir,
    prefix: RASTER_PREFIX,
    format,
    dpi: RASTER_DPI,
    jpegQuality: RASTER_JPEG_QUALITY,
    workspace,
    deadline,
    signal,
  });
  throwForOutcome(raster);

  const pages = await collectProducedFiles(rasterDir, target.extension);
  if (pages.length === 0) {
    throw Errors.convertFailed(
      `rasteriser produced no images (exit=${raster.exitCode} signal=${raster.signal ?? 'none'} stderr=${raster.stderr})`,
    );
  }
  // Checked before the archive is built, because the archive is built in
  // memory: see MAX_RASTER_PAGES.
  if (pages.length > MAX_RASTER_PAGES) {
    throw Errors.tooLarge(
      `document produced ${pages.length} pages, over the ${MAX_RASTER_PAGES} page limit for image export`,
    );
  }

  return pages.map((page, index) => ({
    // Numbered from the sort order rather than from the filename, so the
    // archive runs 1..N whatever pdftoppm decided to call the files.
    name: `${RASTER_PREFIX}-${index + 1}${target.extension}`,
    data: page.data,
  }));
}

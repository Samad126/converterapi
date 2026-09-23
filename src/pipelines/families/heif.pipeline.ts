/**
 * engine: `.heic`/`.heif` in either direction - see `heif.engine.ts`.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { AllowedExtension, TargetFormat } from '../../formats.ts';
import { runFfmpeg } from '../../engines/ffmpeg.engine.ts';
import { runHeifDecode, runHeifEncode } from '../../engines/heif.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Every extension `heif-convert` writes directly from a `.heic`/`.heif`
 * source - verified by hand against a real HEIC file. Everything else in
 * `TRANSCODE_TARGETS` (`bmp`/`gif`/`webp`/`avif`/`ico`) goes through an
 * intermediate PNG instead - see `runHeifPipeline` below.
 */
const HEIF_CONVERT_DIRECT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

/**
 * Run the `heif` engine for a pair `formats.ts` marks `mode: 'heif'` (a
 * `.heic`/`.heif` target) OR an ordinary `transcode` pair whose SOURCE is
 * `.heic`/`.heif` (see `resolveConversion`'s own `heif`-before-`transcode`
 * branch). Both directions land here because both need the same two tools,
 * just in whichever order the pair actually calls for - see this file's own
 * `heif.engine.ts` header comment for why neither `ffmpeg` nor a single
 * subprocess can do this alone.
 */
export async function runHeifPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  sourceExtension: AllowedExtension;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, sourceExtension, target, deadline, signal } = run;
  await fsp.mkdir(outDir, { recursive: true });

  const sourceIsHeif = sourceExtension === '.heic' || sourceExtension === '.heif';
  const targetIsHeif = target.id === 'heic' || target.id === 'heif';

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);

  if (sourceIsHeif && !targetIsHeif && HEIF_CONVERT_DIRECT_EXTENSIONS.has(target.extension)) {
    // `heif-convert` writes this target's extension itself - one process.
    const outcome = await runHeifDecode({ inputPath, outputPath, workspace, deadline, signal });
    throwForOutcome(outcome);
    throwForNonZeroExit(outcome, 'heif-convert');
  } else if (sourceIsHeif) {
    // Decode to an intermediate PNG first, then finish with whichever engine
    // the target actually needs - `heif-enc` for a `.heic`/`.heif` target
    // (a HEIC->HEIF repackage, e.g.), `ffmpeg` for anything else.
    const intermediatePath = join(workspace, 'heif-intermediate.png');
    const decodeOutcome = await runHeifDecode({
      inputPath,
      outputPath: intermediatePath,
      workspace,
      deadline,
      signal,
    });
    throwForOutcome(decodeOutcome);
    throwForNonZeroExit(decodeOutcome, 'heif-convert');

    if (targetIsHeif) {
      const encodeOutcome = await runHeifEncode({
        inputPath: intermediatePath,
        outputPath,
        workspace,
        deadline,
        signal,
      });
      throwForOutcome(encodeOutcome);
      throwForNonZeroExit(encodeOutcome, 'heif-enc');
    } else {
      const ffmpegOutcome = await runFfmpeg({
        inputPath: intermediatePath,
        outputPath,
        workspace,
        deadline,
        signal,
      });
      throwForOutcome(ffmpegOutcome);
      throwForNonZeroExit(ffmpegOutcome, 'ffmpeg');
    }
  } else {
    // An ordinary image source asking for `heic`/`heif`. `heif-enc` only
    // reads PNG/JPEG (verified by hand), so anything else is transcoded to
    // an intermediate PNG by `ffmpeg` first - the same step every other
    // `TRANSCODE_TARGETS` source already goes through, just run one step
    // earlier.
    const canEncodeDirectly =
      sourceExtension === '.png' || sourceExtension === '.jpg' || sourceExtension === '.jpeg';
    const encodeInputPath = canEncodeDirectly ? inputPath : join(workspace, 'heif-intermediate.png');

    if (!canEncodeDirectly) {
      const ffmpegOutcome = await runFfmpeg({
        inputPath,
        outputPath: encodeInputPath,
        workspace,
        deadline,
        signal,
      });
      throwForOutcome(ffmpegOutcome);
      throwForNonZeroExit(ffmpegOutcome, 'ffmpeg');
    }

    const encodeOutcome = await runHeifEncode({
      inputPath: encodeInputPath,
      outputPath,
      workspace,
      deadline,
      signal,
    });
    throwForOutcome(encodeOutcome);
    throwForNonZeroExit(encodeOutcome, 'heif-enc');
  }

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(`heif engine produced no ${target.extension} file`);
  }

  return [{ name: outputName, data: file.data }];
}

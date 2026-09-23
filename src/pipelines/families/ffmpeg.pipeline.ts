/**
 * engine: an image source asking for another image format, answered by
 * ffmpeg.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { runFfmpeg } from '../../engines/ffmpeg.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Run `ffmpeg` for a source/target pair `formats.ts` marks `mode:
 * 'transcode'`. Shaped like `runPandocPipeline` - one process, one output
 * file expected in `outDir` - because the failure modes are the same:
 * a wedged process, a client that left, an empty file left behind by a
 * crash.
 */
export async function runFfmpegPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, target, deadline, signal } = run;

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);
  await fsp.mkdir(outDir, { recursive: true });

  const outcome = await runFfmpeg({ inputPath, outputPath, workspace, deadline, signal });
  throwForOutcome(outcome);
  throwForNonZeroExit(outcome, 'ffmpeg');

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `ffmpeg produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

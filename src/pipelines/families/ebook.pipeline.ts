/**
 * engine: an ebook source asking for another ebook format, answered by
 * ebook-convert (Calibre) - see ebook.engine.ts.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { runEbookConvert } from '../../engines/ebook.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Run `ebook-convert` for a `mode: 'ebook'` target, or for the
 * `engineFrom.ebook` route into `epub` - both land here, same as
 * `runHeifPipeline` serves both a `heic`/`heif` target and a `.heic`/`.heif`
 * SOURCE reaching an ordinary transcode target. Shaped exactly like
 * `runFfmpegPipeline`/`runAssimpPipeline` above - one process, one output
 * file.
 */
export async function runEbookPipeline(run: {
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

  const outcome = await runEbookConvert({ inputPath, outputPath, workspace, deadline, signal });
  throwForOutcome(outcome);
  throwForNonZeroExit(outcome, 'ebook-convert');

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `ebook-convert produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

/**
 * engine: a font source asking for another font format, answered by
 * font_engine.py (fontTools) - see font.engine.ts.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { runFontConvert } from '../../engines/font.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

export async function runFontPipeline(run: {
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

  const outcome = await runFontConvert({ inputPath, outputPath, workspace, deadline, signal });
  throwForOutcome(outcome);
  throwForNonZeroExit(outcome, 'font_engine.py');

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `font_engine.py produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

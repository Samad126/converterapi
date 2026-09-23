/**
 * engine: a 3D-model source asking for another 3D format, answered by
 * assimp - see assimp.engine.ts.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { runAssimpExport } from '../../engines/assimp.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Run `assimp` for a source/target pair `formats.ts` marks `mode: '3d'`.
 * Shaped exactly like `runFfmpegPipeline` above - one process, one output
 * file expected in `outDir` (a `.obj` target's incidental companion `.mtl`
 * simply does not match `target.extension` and is left unread, same as any
 * other engine's extra output file - see `assimp.engine.ts`'s own header
 * comment).
 */
export async function runAssimpPipeline(run: {
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

  const outcome = await runAssimpExport({ inputPath, outputPath, workspace, deadline, signal });
  throwForOutcome(outcome);
  throwForNonZeroExit(outcome, 'assimp');

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `assimp produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

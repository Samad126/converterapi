/**
 * engine: a markup source (.md/.rst/.tex/...) asking for docx/html/odt/rtf/
 * txt/markdown, answered by pandoc.
 */
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { PANDOC_WRITERS, runPandoc } from '../../engines/pandoc.engine.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Run pandoc for a source `formats.ts` names under `target.engineFrom.pandoc`.
 *
 * Shaped like `runEnginePipeline`: one process, one output file expected in
 * `outDir`, the same deadline/abort-signal handling every pipeline here uses.
 * `target.id` cannot double as the pandoc writer name the way it does for
 * `PdfEngineOperation` - pandoc's own writer for the `markdown` target is
 * `gfm`, not `markdown` - so `PANDOC_WRITERS` looks it up instead.
 */
export async function runPandocPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, target, deadline, signal } = run;
  const writer = PANDOC_WRITERS[target.id];
  if (!writer) {
    // Unreachable as the matrix stands - every target `engineFrom.pandoc`
    // names has an entry in `PANDOC_WRITERS` - but a target added to one
    // without the other should fail loudly here rather than call pandoc
    // with `undefined` as its `-t` argument.
    throw Errors.convertFailed(`no pandoc writer registered for target "${target.id}"`);
  }

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);

  const outcome = await runPandoc({ inputPath, outputPath, writer, workspace, deadline, signal });
  throwForOutcome(outcome);
  throwForNonZeroExit(outcome, `pandoc -t ${writer}`);

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `pandoc -t ${writer} produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

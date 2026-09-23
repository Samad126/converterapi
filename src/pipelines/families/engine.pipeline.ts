/**
 * engine: a PDF asking for docx/pptx/xlsx, answered by pdf_engine.py.
 */
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { PDF_ENGINE_NO_TABLES_EXIT_CODE, runPdfEngine, type PdfEngineOperation } from '../../engines/pdf-engine.engine.ts';
import { collectProducedFiles, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Run `pdf_engine.py` for a `viaEngine` pair - today, only a PDF asking for
 * `docx`, `pptx` or `xlsx`.
 *
 * The target's own id doubles as the operation name: `PdfEngineOperation` is
 * exactly `'docx' | 'pptx' | 'xlsx'`, which is exactly the three ids
 * `engineFrom` ever appears on, so there is nothing else to look up. Shaped
 * like `runDirectPipeline` - write to `outDir`, respect the deadline and the
 * abort signal, insist the output is really there - because the failure modes
 * are the same failure modes: a wedged process, a client that left, an empty
 * file left behind by a crash.
 */
export async function runEnginePipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
  ocr?: boolean;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, target, deadline, signal, ocr } = run;
  const operation = target.id as PdfEngineOperation;

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);

  const outcome = await runPdfEngine({
    operation,
    inputPath,
    outputPath,
    workspace,
    deadline,
    signal,
    ocr,
  });

  if (outcome.kind === 'exited' && outcome.exitCode === PDF_ENGINE_NO_TABLES_EXIT_CODE) {
    // Only the xlsx operation uses this exit code (see pdf_engine.py); docx
    // and pptx never produce it, since there is no "this PDF has no
    // paragraphs" or "no pages" equivalent worth a dedicated error.
    throw Errors.noTables();
  }
  throwForOutcome(outcome);

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(
      `pdf_engine.py ${operation} produced no ${target.extension} file ` +
        `(exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  return [{ name: outputName, data: file.data }];
}

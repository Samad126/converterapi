/**
 * direct: one soffice run, one answer.
 */
import { Errors } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { runSoffice } from '../../engines/soffice.engine.ts';
import { collectProducedFiles, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

export async function runDirectPipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  profileDir: string;
  target: TargetFormat;
  convertTo: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, profileDir, target, convertTo, deadline, signal } = run;

  const outcome = await runSoffice({
    inputPath,
    outDir,
    profileDir,
    workspace,
    convertTo,
    deadline,
    signal,
  });
  throwForOutcome(outcome);

  // --convert-to exits 0 even when it produced nothing at all, so the exit code
  // carries no information about success. The only trustworthy signal is the
  // file itself. (Verified: a corrupt .docx gives
  // "Error: source file could not be loaded" and exit status 0.)
  const produced = await collectProducedFiles(outDir, target.extension);
  if (produced.length === 0) {
    throw Errors.convertFailed(
      `soffice produced no ${target.extension} file (exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr})`,
    );
  }

  // A direct export always writes exactly one file. Naming it after what it is
  // rather than after soffice's internal `input` basename means the download
  // prompt says "converted.xlsx" instead of "input.xlsx".
  if (produced.length === 1) {
    return [{ name: `converted${target.extension}`, data: produced[0]!.data }];
  }
  return produced;
}

/**
 * The `word`, `slides` and `sheet` targets: PDF in, DOCX/PPTX/XLSX out, with no
 * LibreOffice involved.
 *
 * A PDF opens in LibreOffice as a Draw document, and Draw has no Writer/Calc/
 * Impress export filter - confirmed against the shipped LibreOffice by running
 * `soffice --convert-to docx/pptx/xlsx` on a real PDF and getting "no export
 * filter found" every time. `formats.ts` is explicit that these three targets
 * are not `soffice --convert-to` at all: they shell out to
 * `scripts/pdf_engine.py`, a second and unrelated conversion engine.
 *
 * Reuses `runProcess` from soffice.service.ts rather than a second copy of it:
 * the failure modes are identical (a wedged process, a client that left, a
 * deadline shared with the rest of the pipeline), and the two engines
 * disagreeing about how a subprocess is killed would be a bug waiting to
 * happen.
 */
import { PDF_ENGINE_SCRIPT, PYTHON_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export type PdfEngineOperation = 'docx' | 'pptx' | 'xlsx';

/**
 * Exit code `pdf_engine.py`'s xlsx operation uses to say "this PDF has no
 * detectable tables" - the PDF-source twin of E_NO_TABLES for a Word document.
 * Not a failure: the file opened fine and simply has nothing this pipeline can
 * extract.
 */
export const PDF_ENGINE_NO_TABLES_EXIT_CODE = 2;

export interface PdfEngineRun {
  operation: PdfEngineOperation;
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runPdfEngine(run: PdfEngineRun): Promise<ProcessOutcome> {
  const { operation, inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: PYTHON_BIN,
    args: [PDF_ENGINE_SCRIPT, operation, inputPath, outputPath],
    workspace,
    deadline,
    signal,
    // `runProcess` points every child's HOME at the per-request workspace,
    // which is exactly right for soffice - it is what keeps concurrent
    // profiles from colliding - and exactly wrong here: Python resolves a
    // `pip install --user` package under `$HOME/.local`, so a sandboxed HOME
    // makes an installed dependency invisible and the engine fails with a
    // ModuleNotFoundError that has nothing to do with the PDF. The container
    // image installs these system-wide, where this would not matter, but the
    // real HOME costs nothing to restore and is what makes a non-Docker
    // install (or any environment using `--user` packages) work too.
    env: { HOME: process.env.HOME ?? workspace },
  });
}

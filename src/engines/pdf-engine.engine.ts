/**
 * The `docx`, `pptx`, `xlsx` and `markdown` targets, for a PDF SOURCE: PDF in,
 * DOCX/PPTX/XLSX/Markdown out, with no LibreOffice involved.
 *
 * A PDF opens in LibreOffice as a Draw document, and Draw has no Writer/Calc/
 * Impress export filter - confirmed against the shipped LibreOffice by running
 * `soffice --convert-to docx/pptx/xlsx` on a real PDF and getting "no export
 * filter found" every time. `formats.ts` is explicit that these targets are
 * not `soffice --convert-to` at all (markdown has no LibreOffice export
 * filter to speak of, on any source): they shell out to `scripts/
 * pdf_engine.py`, a second and unrelated conversion engine.
 *
 * Reuses `runProcess` from soffice.engine.ts rather than a second copy of it:
 * the failure modes are identical (a wedged process, a client that left, a
 * deadline shared with the rest of the pipeline), and the two engines
 * disagreeing about how a subprocess is killed would be a bug waiting to
 * happen.
 */
import { PDF_ENGINE_SCRIPT, PYTHON_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.engine.ts';

export type PdfEngineOperation = 'docx' | 'pptx' | 'xlsx' | 'markdown' | 'ocr';

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
  /**
   * `docx` only: OCR a PDF with no extractable text (a scan) before
   * reconstructing it, so a scanned page becomes real text instead of an
   * uneditable picture. Defaults to true. Harmless to pass for `pptx`/
   * `xlsx` - `pdf_engine.py` accepts it positionally for every operation and
   * only `convert_to_docx` reads it, so the caller here never has to
   * special-case which operation this run is.
   */
  ocr?: boolean;
  /**
   * `ocr` operation only: re-OCR from scratch even if the page already has a
   * text layer this pipeline would otherwise trust. Defaults to false - the
   * same "trust existing text unless told otherwise" default every other
   * caller of `_pdf_has_no_extractable_text` uses. Shares the same
   * positional argument slot as `ocr` above (`pdf_engine.py` only ever runs
   * one of the two operations that read it), so passing both together would
   * be a caller bug, not something this interface needs to prevent - nothing
   * in `pages.controller.ts` does.
   */
  force?: boolean;
}

export function runPdfEngine(run: PdfEngineRun): Promise<ProcessOutcome> {
  const { operation, inputPath, outputPath, workspace, deadline, signal, ocr, force } = run;
  const flag = operation === 'ocr' ? String(force ?? false) : String(ocr ?? true);

  return runProcess({
    bin: PYTHON_BIN,
    args: [PDF_ENGINE_SCRIPT, operation, inputPath, outputPath, flag],
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

export interface PdfCompareRun {
  inputPathA: string;
  inputPathB: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/**
 * `/pdf/compare`'s engine call: two PDFs in, a JSON diff report written to
 * `outputPath`.
 *
 * Deliberately NOT `PdfEngineRun` with a second input bolted on: that
 * interface's whole shape - one `inputPath`, one `operation` id reused as
 * both the CLI verb and (for `docx`) a flag name - is built around "one file
 * becomes one file", which `compare` genuinely is not. Forcing it in would
 * mean either a second unused `inputPath`-shaped field on every other run or
 * a union type every call site has to narrow before it can read anything -
 * more confusing than a second small function that mirrors `runPdfEngine`'s
 * body almost exactly.
 */
export function runPdfCompare(run: PdfCompareRun): Promise<ProcessOutcome> {
  const { inputPathA, inputPathB, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: PYTHON_BIN,
    args: [PDF_ENGINE_SCRIPT, 'compare', inputPathA, inputPathB, outputPath],
    workspace,
    deadline,
    signal,
    // See runPdfEngine's identical comment: a sandboxed HOME hides Python
    // packages installed under `--user`, which has nothing to do with either
    // PDF being compared.
    env: { HOME: process.env.HOME ?? workspace },
  });
}

export interface PdfRedactRun {
  inputPath: string;
  /**
   * Path to a JSON file (already written into the request workspace by the
   * caller) holding the array of `{page, x, y, width, height}` regions to
   * strip. Not a raw JSON string on argv, for the same reason
   * `pdf_engine.py`'s own docstring gives for this operation: an argv string
   * is subject to shell/exec argument-length limits and escaping hazards a
   * long list of regions could realistically hit, where a file the caller
   * already has a workspace for does not.
   */
  areasPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/**
 * `/pdf/redact`'s engine call: one PDF plus a JSON side-input describing the
 * regions to strip, one redacted PDF out.
 *
 * A sibling of `runPdfCompare`, not a `PdfEngineRun` variant, for the same
 * reason `runPdfCompare`'s own doc comment gives: this operation's shape
 * (two paths in beyond the single `inputPath`/`outputPath` pair, neither of
 * them the `ocr`/`force` flag `PdfEngineRun` already carries) does not fit
 * that interface without either a second unused field on every other run or
 * a union every call site has to narrow before reading anything.
 */
export function runPdfRedact(run: PdfRedactRun): Promise<ProcessOutcome> {
  const { inputPath, areasPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: PYTHON_BIN,
    args: [PDF_ENGINE_SCRIPT, 'redact', inputPath, areasPath, outputPath],
    workspace,
    deadline,
    signal,
    // See runPdfEngine's identical comment: a sandboxed HOME hides Python
    // packages installed under `--user`, which has nothing to do with the
    // PDF being redacted.
    env: { HOME: process.env.HOME ?? workspace },
  });
}

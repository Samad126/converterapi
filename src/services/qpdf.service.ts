/**
 * The `protect` and `unlock` endpoints: adding or removing a PDF's owner/user
 * password.
 *
 * `pdf-lib`, which does every other page operation in this service, is
 * explicit that it does not implement PDF encryption at all - there is no
 * `setEncryption` anywhere in it, by design (see its README). Password
 * protection is therefore a fourth, unrelated engine, the same way the
 * `docx`/`pptx`/`xlsx` targets from a PDF needed `pdf_engine.py` rather than
 * LibreOffice: the right tool for THIS job is `qpdf`, a small, dependency-free
 * CLI built for exactly this, and reusing `runProcess` from
 * soffice.service.ts keeps its failure handling (a wedged process, a client
 * that left, a shared deadline) identical to every other subprocess this
 * service runs.
 */
import { QPDF_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export interface QpdfRunOptions {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/**
 * Encrypt `inputPath` with `password` as both the user and owner password.
 *
 * `--user-password` alone (no separate owner password) would leave the file
 * "protected" only from readers, but wide open to anyone re-encrypting it
 * with qpdf itself - not what "add a password" means to someone using this
 * endpoint.
 */
export function protectWithQpdf(run: QpdfRunOptions & { password: string }): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal, password } = run;
  return runProcess({
    bin: QPDF_BIN,
    args: [
      '--encrypt',
      password,
      password,
      '256',
      '--',
      inputPath,
      outputPath,
    ],
    workspace,
    deadline,
    signal,
  });
}

/**
 * Decrypt `inputPath`, which must already be encrypted with `password`.
 *
 * qpdf exits non-zero for a wrong password rather than writing a partial
 * file, which is exactly the distinction the controller needs to tell "the
 * password was wrong" apart from "something else about this file is broken".
 */
export function unlockWithQpdf(run: QpdfRunOptions & { password: string }): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal, password } = run;
  return runProcess({
    bin: QPDF_BIN,
    args: ['--password=' + password, '--decrypt', '--', inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

/**
 * Read `inputPath` and rewrite it, fixing whatever qpdf's own reader can
 * recover from: a corrupt or missing cross-reference table, a truncated
 * update, a broken linearization hint stream and the like.
 *
 * Plain `qpdf in out` already does this - qpdf's reader recovers what it can
 * while parsing, and simply writing the file back out is what makes that
 * recovery permanent, the same way "open and re-save" repairs a shaky Office
 * document. `--replace-input` is deliberately NOT used: this endpoint's
 * contract is "give me a fixed copy", not "fix the file I gave you", and the
 * two-path form is what lets a repair attempt fail without touching the
 * input the request cleans up afterwards either way.
 */
export function repairWithQpdf(run: QpdfRunOptions): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;
  return runProcess({
    bin: QPDF_BIN,
    args: [inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

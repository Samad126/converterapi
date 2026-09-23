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
 * soffice.engine.ts keeps its failure handling (a wedged process, a client
 * that left, a shared deadline) identical to every other subprocess this
 * service runs.
 */
import { QPDF_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.engine.ts';

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

export type CompressLevel = 'low' | 'medium' | 'high';

/**
 * Per-level qpdf flags for `compressWithQpdf`, verified against a real qpdf
 * 11.9.0 binary (`qpdf --help=all`) rather than assumed from memory - qpdf
 * has no `--jpeg-quality` flag in that build (and Debian bookworm's shipped
 * qpdf, 10.6.3, predates it too), so unlike a Ghostscript-based compressor
 * there is no lossy "requality this image" knob available here at all.
 * Every stage of aggressiveness below is therefore built entirely out of
 * qpdf's real, verified flags:
 *
 *   - `--compress-streams=y` / `--object-streams=generate` recompact the
 *     PDF's own object and stream structure. This is lossless in the sense
 *     that matters to this endpoint's callers - no visible content changes -
 *     so it is applied at every level, including `low`.
 *   - `--recompress-flate --compression-level=9` re-runs flate (zip/gzip)
 *     compression at its slowest, smallest setting. Still lossless (flate is
 *     a lossless codec), but skipped at `low` because it costs CPU for
 *     content that is very often already near-optimally flate-compressed by
 *     whatever produced the PDF.
 *   - `--optimize-images` is the only lever with a real space/quality
 *     trade-off: it re-encodes an image as JPEG when doing so is smaller,
 *     which is lossy for the images it touches. `--oi-min-width`/`-height`/
 *     `-area` gate WHICH images qualify - lower thresholds mean more images
 *     (including small ones, where JPEG's block artifacts are most visible)
 *     get re-encoded. Since qpdf gives no quality dial, "more aggressive"
 *     here means "more willing to touch smaller images", not "worse JPEG
 *     quality" - that is the deliberate substitute for the `--jpeg-quality`
 *     lever the brief anticipated but that does not exist in this CLI.
 */
const COMPRESS_LEVEL_ARGS: Record<CompressLevel, readonly string[]> = {
  low: ['--compress-streams=y', '--object-streams=generate'],
  medium: [
    '--compress-streams=y',
    '--object-streams=generate',
    '--recompress-flate',
    '--compression-level=9',
    '--optimize-images',
    '--oi-min-width=200',
    '--oi-min-height=200',
    '--oi-min-area=40000',
  ],
  high: [
    '--compress-streams=y',
    '--object-streams=generate',
    '--recompress-flate',
    '--compression-level=9',
    '--optimize-images',
    '--oi-min-width=0',
    '--oi-min-height=0',
    '--oi-min-area=0',
  ],
};

/**
 * Recompress `inputPath` with qpdf's own stream/object/image recompaction
 * flags - no Ghostscript, no second engine, because qpdf is already a
 * required system dependency for `protect`/`unlock`/`repair` above and its
 * `--optimize-images`/`--compress-streams`/`--object-streams` flags do the
 * same job Ghostscript's `-dPDFSETTINGS` presets do, without adding a fifth
 * PDF-touching binary to the image for one more endpoint.
 *
 * `level` (default `'medium'`) selects one of the three flag sets in
 * `COMPRESS_LEVEL_ARGS` - see the comment there for exactly what each one
 * does and why. Unlike `protect`/`unlock`, this always exits 0 or a real
 * error; there is no warnings-tolerant exit 3 path to reason about the way
 * `repairWithQpdf` and `/pdf/repair` do.
 */
export function compressWithQpdf(run: QpdfRunOptions & { level?: CompressLevel }): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal, level = 'medium' } = run;
  return runProcess({
    bin: QPDF_BIN,
    args: [...COMPRESS_LEVEL_ARGS[level], '--', inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

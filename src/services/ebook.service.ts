/**
 * `ebook-convert` (Calibre), run as a subprocess exactly as `ffmpeg`/
 * `heif-convert`/`assimp` are - the ebook engine: `.epub`/`.mobi`/`.azw3`/
 * `.fb2`/`.lrf`/`.pdb` in, any of `epub`/`mobi`/`azw3`/`fb2`/`lrf`/`pdb`/
 * `snb`/`kepub` out. A flat format-to-format tool, no per-flag invocation
 * needed for the pairs this service advertises - `ebook-convert <in> <out>`
 * picks both plugins from each path's own extension, verified by hand for
 * the full matrix (every one of the six readable sources into all eight
 * targets, sixty pairs, zero failures).
 *
 * `.snb` IS NOT A READ SOURCE - deliberately, and not merely an omission.
 * This build's SNB *input* plugin never populates a document's title
 * metadata, which crashes nearly every writer downstream trying to read it
 * back out (verified by hand: `IndexError: list index out of range` in
 * `cover.py`/`mobi`'s own writer/`azw3`'s own writer/`lrf`'s own writer/
 * `fb2`'s own writer - every one but `pdb`, which happens not to need a
 * title at all). Writing `.snb` works fine (verified by hand, from every
 * other source) - this is the same asymmetric "one direction is a real,
 * tested filter and the other is not" shape `.rar` already has elsewhere in
 * this service, just the opposite direction.
 *
 * `kepub` NEEDS THE LITERAL DOUBLE EXTENSION `.kepub.epub` ON THE OUTPUT
 * PATH, not a bare `.kepub` - verified by hand (`ebook-convert in.epub
 * out.kepub` fails with "No plugin to handle output format: kepub"; Calibre
 * only recognises the KEPUB writer by that exact double suffix, the reason
 * a real Kobo device also expects it). See `kepub`'s own `TargetFormat`
 * entry in `formats.ts` for why this needs no separate SOURCE extension of
 * its own: a `.kepub.epub` file IS a real EPUB container underneath, so the
 * ordinary `.epub` reader already opens it - confirmed by hand, feeding a
 * real `.kepub.epub` fixture back into `ebook-convert` as a source.
 */
import { EBOOK_CONVERT_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export interface EbookRun {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runEbookConvert(run: EbookRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: EBOOK_CONVERT_BIN,
    args: [inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

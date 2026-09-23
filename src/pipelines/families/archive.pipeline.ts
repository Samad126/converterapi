/**
 * engine: an archive source (.zip/.tar/.tar.gz/.7z/...) asking for another
 * archive format, answered by 7z.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../../errors.ts';
import type { AllowedExtension, TargetFormat } from '../../formats.ts';
import { collectTreeFiles, createArchive, decompressZstd, extractArchiveTree } from '../../engines/archive.engine.ts';
import { zipDeflated } from '../../lib/zip.ts';
import { collectProducedFiles, throwForNonZeroExit, throwForOutcome } from '../pipeline.shared.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * List, validate and unpack the source archive, then repack the tree into
 * the target format. See `archive.engine.ts`'s own header comment for the
 * security reasoning - this is the one pipeline here that writes untrusted
 * archive contents to disk before the response is built.
 *
 * `zip` is written by `zip.ts`'s `zipDeflated` rather than another `7z`
 * subprocess call, per `createArchive`'s own comment: a format this codebase
 * already trusts a few hundred lines to describe does not need a dependency
 * to write it too.
 */
export async function runArchivePipeline(run: {
  inputPath: string;
  outDir: string;
  workspace: string;
  sourceExtension: AllowedExtension;
  target: TargetFormat;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, outDir, workspace, sourceExtension, target, deadline, signal } = run;
  const writer = target.archiveWriter;
  if (!writer) {
    // Unreachable as the matrix stands - `validateMatrix` refuses an
    // `archive`-mode target with no `archiveWriter` - but a target added to
    // one without the other should fail loudly here rather than silently
    // produce nothing.
    throw Errors.convertFailed(`no archiveWriter registered for target "${target.id}"`);
  }

  // `.zst` needs its outer Zstandard layer undone by the standalone `zstd`
  // CLI before `extractArchiveTree` ever runs `7z l` on it - `7z` has no
  // Zstandard codec in this build at all (see `ZSTD_BIN`'s own comment in
  // `config.ts`), unlike gzip/bzip2/xz, which `extractArchiveTree` already
  // reads natively through plain `7z`. The decompressed file then goes
  // through the EXACT SAME path a `.tar` upload would - if it is itself a
  // tarball (`report.tar.zst`, the common case), `extractArchiveTree`'s own
  // `7z l` on it just works; if it is a single non-tar file (`.zst` used the
  // way `gzip -k` compresses one document), the same "not an archive"
  // failure a bare `.zst` of a text file already gets from `7z l` today.
  const archivePath =
    sourceExtension === '.zst'
      ? await (async () => {
          const decompressedPath = join(workspace, 'archive-zst-decompressed');
          const outcome = await decompressZstd({
            inputPath,
            outputPath: decompressedPath,
            workspace,
            deadline,
            signal,
          });
          throwForOutcome(outcome);
          throwForNonZeroExit(outcome, 'zstd');
          return decompressedPath;
        })()
      : inputPath;

  const extractDir = join(workspace, 'archive-extracted');
  const tree = await extractArchiveTree({
    archivePath,
    workspace,
    outDir: extractDir,
    deadline,
    signal,
  });

  if (writer === 'zip') {
    const files = await collectTreeFiles(tree);
    return [{ name: `converted${target.extension}`, data: zipDeflated(files) }];
  }

  const outputName = `converted${target.extension}`;
  const outputPath = join(outDir, outputName);
  await fsp.mkdir(outDir, { recursive: true });
  await createArchive({ writer, sourceDir: tree, outputPath, workspace, deadline, signal });

  const produced = await collectProducedFiles(outDir, target.extension);
  const file = produced.find((entry) => entry.name === outputName) ?? produced[0];
  if (!file) {
    throw Errors.convertFailed(`7z produced no ${target.extension} file for archive target "${target.id}"`);
  }

  return [{ name: outputName, data: file.data }];
}

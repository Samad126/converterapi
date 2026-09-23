/**
 * The archive engine: `.zip`/`.tar`/`.tgz`/`.tbz2`/`.txz`/`.gz`/`.bz2`/`.xz`/
 * `.7z`/`.iso` in, `zip`/`tar`/`tar.gz`/`tar.bz2`/`7z` out. A fourth
 * conversion engine, running `7z` (p7zip) as a subprocess exactly as
 * `soffice`/`pandoc`/`pdf_engine.py` are.
 *
 * THIS IS GENUINELY NEW GROUND FOR THIS SERVICE. `unzip.ts`'s own header
 * comment states the house rule this file breaks on purpose: "we look up ONE
 * entry by name and return its bytes. We never list the archive, never write
 * anything to disk, and never build a path out of a name that came from
 * inside the file. Zip-slip is a hazard of unpacking, and we do not unpack."
 * Converting an archive to another archive format IS unpacking - there is no
 * way to repack a `.zip` as a `.tar` without first putting its files
 * somewhere - so every mitigation that rule made unnecessary elsewhere has to
 * exist here instead:
 *
 *   1. LIST BEFORE EXTRACTING. `7z l -slt` reports every entry's declared
 *      path, size and attributes without writing a single byte to disk.
 *      `validateEntries` below refuses the whole conversion - before any
 *      extraction runs - if the entry count or total declared size exceeds
 *      `MAX_ARCHIVE_ENTRIES`/`MAX_ARCHIVE_UNCOMPRESSED_BYTES`, if any entry's
 *      path escapes the extraction directory, or if any entry is a symlink.
 *      This is the same "refuse before doing the work" shape
 *      `MAX_DOCUMENT_XML_BYTES` and `MAX_PSD_DECODE_BYTES` already use for
 *      their own decompression-bomb bounds.
 *   2. SYMLINKS ARE REFUSED OUTRIGHT, not merely "not followed". A symlink
 *      inside an archive being converted serves no purpose this feature
 *      needs, so rather than trying to tell a safe internal symlink from a
 *      dangerous one, every symlink entry fails the whole conversion. Belt
 *      and braces: `7z x` on this build already refuses to write a symlink
 *      whose target would escape the extraction directory (verified by
 *      hand: `ERROR: Dangerous link path was ignored` and a non-zero exit),
 *      so this is a second, independent check ahead of the first rather
 *      than the only one.
 *   3. PATH TRAVERSAL IS CHECKED OURSELVES TOO, ahead of 7z's own defence
 *      (also verified by hand: a `../../escape` entry name is written
 *      INSIDE the extraction directory, not resolved against it - 7z on
 *      Linux does not treat `..` in an archived path as an instruction to
 *      escape). A path is rejected if any of its segments is `.` or `..`,
 *      or if it is absolute.
 *   4. EVERY ENTRY IS WRITTEN INTO A DEDICATED, PER-REQUEST SUBDIRECTORY of
 *      the workspace `createWorkspace()` already gives this request - the
 *      same per-request isolation and 0700 permissions every other engine
 *      gets, nothing new.
 *   5. `7z x`'S EXIT CODE IS THE ONLY THING TRUSTED. Any non-zero exit -
 *      whether it is a warning about one skipped entry or a hard failure -
 *      fails the whole conversion rather than trying to tell "a warning we
 *      can ignore" from "a warning that matters" apart from stderr text,
 *      which is not a distinction the CLI promises to make reliably.
 *
 * A COMPOUND SOURCE (`.tar.gz`, `.tar.bz2`, `.tar.xz`) NEEDS TWO PASSES.
 * Node's `path.extname` only ever returns the LAST extension, so a
 * `report.tar.gz` upload is accepted as `.gz` (an already-supported source),
 * not a distinct `.tar.gz` extension - and `7z x` on a `.gz` only undoes the
 * gzip layer, leaving a `.tar` file behind rather than the files inside it
 * (verified by hand). `extractArchiveTree` detects exactly this shape - the
 * first pass produced a single regular file ending in `.tar` - and recurses
 * into it once, listing and validating that inner tar exactly as it did the
 * outer archive before extracting it for real.
 */
import fsp from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_UNCOMPRESSED_BYTES, SEVENZIP_BIN, ZSTD_BIN } from '../config.ts';
import { ClientGoneError, Errors } from '../errors.ts';
import { runProcess, type ProcessOutcome } from './soffice.engine.ts';

export type ArchiveWriter = 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.zst' | '7z';

/** Exported for direct unit testing - see `test/archive.test.ts`. */
export interface ArchiveEntry {
  path: string;
  isFolder: boolean;
  /** Declared uncompressed size, in bytes - not trusted past the sum check. */
  size: number;
  /** `7z l -slt`'s `Attributes` field, e.g. ` -rw-rw-r--` or ` lrwxrwxrwx`. */
  attributes: string;
  encrypted: boolean;
}

/**
 * Run `7z l -slt` and parse its entry blocks.
 *
 * `-slt` ("show technical information") is what makes the output a series of
 * `Key = Value` blocks rather than a fixed-width table - the only format
 * stable enough to parse without guessing at column widths, which is what
 * every other `7z l` output is.
 */
async function listEntries(run: {
  archivePath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<{ outcome: ProcessOutcome; entries: ArchiveEntry[] }> {
  const { archivePath, workspace, deadline, signal } = run;

  const outcome = await runProcess({
    bin: SEVENZIP_BIN,
    args: ['l', '-slt', '-ba', '--', archivePath],
    workspace,
    deadline,
    signal,
    captureStdout: true,
  });

  const entries: ArchiveEntry[] = [];
  if (outcome.kind !== 'exited' || outcome.exitCode !== 0) return { outcome, entries };

  // `-ba` drops the banner/summary, so stdout is exactly the entry blocks,
  // each terminated by a blank line.
  let current: Partial<ArchiveEntry> & { path?: string } = {};
  const flush = () => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        isFolder: current.isFolder ?? false,
        size: current.size ?? 0,
        attributes: current.attributes ?? '',
        encrypted: current.encrypted ?? false,
      });
    }
    current = {};
  };
  for (const line of (outcome.stdout ?? '').split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const eq = line.indexOf(' = ');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 3);
    if (key === 'Path') current.path = value;
    else if (key === 'Folder') current.isFolder = value === '+';
    else if (key === 'Size') current.size = Number(value) || 0;
    else if (key === 'Attributes') current.attributes = value;
    else if (key === 'Encrypted') current.encrypted = value === '+';
  }
  flush();

  return { outcome, entries };
}

/**
 * Refuse before any bytes are written: entry count, total declared size,
 * path traversal, symlinks, encryption. See this file's own header comment
 * for why each of these exists.
 */
/** Exported for direct unit testing - see `test/archive.test.ts`. */
export function validateEntries(entries: readonly ArchiveEntry[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw Errors.convertFailed(
      `archive has ${entries.length} entries, which is over the ${MAX_ARCHIVE_ENTRIES} limit`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted) throw Errors.encrypted();

    // A symlink's Attributes string starts with 'l' in the unix mode column
    // 7z reports (` lrwxrwxrwx`, vs. ` -rw-r--r--` for a plain file or
    // `D drwxr-xr-x` for a folder). Refused outright - see header comment.
    if (/^\s*l/.test(entry.attributes)) {
      throw Errors.convertFailed(`archive entry "${entry.path}" is a symlink, which is refused`);
    }

    const normalized = entry.path.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      segments.some((segment) => segment === '.' || segment === '..')
    ) {
      throw Errors.convertFailed(`archive entry "${entry.path}" has an unsafe path`);
    }

    if (!entry.isFolder) total += entry.size;
  }

  if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw Errors.convertFailed(
      `archive declares ${total} bytes of content, which is over the ` +
        `${MAX_ARCHIVE_UNCOMPRESSED_BYTES}-byte limit`,
    );
  }
}

async function extractOnce(run: {
  archivePath: string;
  outDir: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProcessOutcome> {
  const { archivePath, outDir, workspace, deadline, signal } = run;
  await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
  return runProcess({
    bin: SEVENZIP_BIN,
    // `x`, not `e`: full paths preserved, which is what lets the directory
    // structure the source archive declared come through unchanged.
    args: ['x', `-o${outDir}`, '-y', '--', archivePath],
    workspace,
    deadline,
    signal,
  });
}

/**
 * Undo the OUTER Zstandard layer of a `.zst` source with the standalone
 * `zstd` CLI, before `extractArchiveTree` ever sees it - `7z` has no
 * Zstandard codec in this build at all (see `ZSTD_BIN`'s own comment in
 * `config.ts`), unlike gzip/bzip2/xz, which it reads natively and which is
 * why THEY need no separate step like this one. The result is hastily
 * checked to be a real archive layer of its own: an already-plain file
 * inside a `.zst` (Zstandard's version of `gzip -k` on one document) is not
 * this feature's job to unpack - `runArchivePipeline`'s caller decides that
 * the same way it does for `.gz`, by handing the decompressed path straight
 * to `extractArchiveTree`, which is what would refuse it if there is
 * nothing 7z can list inside.
 */
export async function decompressZstd(run: {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;
  return runProcess({
    bin: ZSTD_BIN,
    args: ['-d', '-f', '-o', outputPath, inputPath],
    workspace,
    deadline,
    signal,
  });
}

/**
 * List, validate, and extract one archive - and, if the result is a single
 * `.tar` file (a `.tar.gz`/`.tar.bz2`/`.tar.xz` source that only had its
 * outer compression layer undone), recurse into it once. See this file's own
 * header comment for why a second pass is sometimes needed.
 *
 * Returns the directory the real file tree ended up in.
 */
export async function extractArchiveTree(run: {
  archivePath: string;
  workspace: string;
  outDir: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { archivePath, workspace, outDir, deadline, signal } = run;

  const { outcome: listOutcome, entries } = await listEntries({
    archivePath,
    workspace,
    deadline,
    signal,
  });
  throwForArchiveOutcome(listOutcome, 'list');
  validateEntries(entries);

  const extractOutcome = await extractOnce({ archivePath, outDir, workspace, deadline, signal });
  throwForArchiveOutcome(extractOutcome, 'extract');

  const produced = await fsp.readdir(outDir, { withFileTypes: true });
  if (produced.length === 1 && produced[0]!.isFile() && produced[0]!.name.endsWith('.tar')) {
    const innerTarPath = join(outDir, produced[0]!.name);
    const innerOutDir = join(workspace, 'archive-inner');

    const { outcome: innerListOutcome, entries: innerEntries } = await listEntries({
      archivePath: innerTarPath,
      workspace,
      deadline,
      signal,
    });
    throwForArchiveOutcome(innerListOutcome, 'list');
    validateEntries(innerEntries);

    const innerExtractOutcome = await extractOnce({
      archivePath: innerTarPath,
      outDir: innerOutDir,
      workspace,
      deadline,
      signal,
    });
    throwForArchiveOutcome(innerExtractOutcome, 'extract');
    return innerOutDir;
  }

  return outDir;
}

function throwForArchiveOutcome(
  outcome: ProcessOutcome,
  step: 'list' | 'extract',
): asserts outcome is Extract<ProcessOutcome, { kind: 'exited' }> {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();
  if (outcome.exitCode !== 0) {
    throw Errors.convertFailed(
      `7z ${step} exited ${outcome.exitCode} (signal=${outcome.signal ?? 'none'}): ` +
        `${outcome.stderr || '(no stderr)'}`,
    );
  }
}

/**
 * Walk an extracted tree and return every regular file's path (relative,
 * forward-slashed) and bytes - what the `zip` target needs to hand to
 * `zipDeflated`, since that writer builds its archive from in-memory entries
 * rather than a directory on disk.
 */
export async function collectTreeFiles(
  root: string,
): Promise<Array<{ name: string; data: Buffer }>> {
  const files: Array<{ name: string; data: Buffer }> = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const data = await fsp.readFile(full);
        const name = relative(root, full).split(sep).join('/');
        files.push({ name, data });
      }
      // Anything else (a device, a fifo) does not come out of `7z x` for an
      // archive that passed `validateEntries`, so there is nothing else to
      // handle here.
    }
  }

  await walk(root);
  return files;
}

/**
 * Pack an already-extracted directory into `tar`/`tar.gz`/`tar.bz2`/`7z`.
 *
 * `zip` is deliberately NOT handled here - see `conversion.pipeline.ts`'s
 * archive pipeline: the project's own rule is that a format describable in a
 * few hundred lines does not justify a dependency, and `zip.ts` already is
 * that description, trusted and in use elsewhere. This function exists for
 * the formats `zip.ts` does not write.
 *
 * `tar.gz`/`tar.bz2` need two `7z a` calls - one archiver cannot write a
 * compound format in a single step (verified by hand: `7z a -tgzip out.tar.gz
 * dir/*` exits with `E_INVALIDARG`) - so an intermediate `.tar` is built
 * first and then compressed in place.
 */
export async function createArchive(run: {
  writer: Exclude<ArchiveWriter, 'zip'>;
  sourceDir: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { writer, sourceDir, outputPath, workspace, deadline, signal } = run;
  // `sourceDir + "/."` includes the directory's CONTENTS without wrapping
  // them in a folder named after `sourceDir` itself - verified by hand
  // against both forms. No shell is involved, so this is a literal argument,
  // not a glob that needs expanding.
  const sourceGlob = `${sourceDir}/.`;

  if (writer === 'tar') {
    const outcome = await runProcess({
      bin: SEVENZIP_BIN,
      args: ['a', '-ttar', outputPath, sourceGlob],
      workspace,
      deadline,
      signal,
    });
    throwForArchiveOutcome(outcome, 'extract');
    return;
  }

  if (writer === '7z') {
    const outcome = await runProcess({
      bin: SEVENZIP_BIN,
      args: ['a', '-t7z', outputPath, sourceGlob],
      workspace,
      deadline,
      signal,
    });
    throwForArchiveOutcome(outcome, 'extract');
    return;
  }

  // tar.gz / tar.bz2 / tar.zst: build the intermediate tar, then compress it.
  const tarPath = join(workspace, 'archive-intermediate.tar');
  const tarOutcome = await runProcess({
    bin: SEVENZIP_BIN,
    args: ['a', '-ttar', tarPath, sourceGlob],
    workspace,
    deadline,
    signal,
  });
  throwForArchiveOutcome(tarOutcome, 'extract');

  if (writer === 'tar.zst') {
    // `7z` has no Zstandard codec in this build (see `ZSTD_BIN`'s own
    // comment in `config.ts`), so this one compression step runs the
    // standalone `zstd` CLI instead of a second `7z a` call.
    const zstdOutcome = await runProcess({
      bin: ZSTD_BIN,
      args: ['-f', '-o', outputPath, tarPath],
      workspace,
      deadline,
      signal,
    });
    throwForArchiveOutcome(zstdOutcome, 'extract');
    return;
  }

  const compressFormat = writer === 'tar.gz' ? 'gzip' : 'bzip2';
  const compressOutcome = await runProcess({
    bin: SEVENZIP_BIN,
    args: ['a', `-t${compressFormat}`, outputPath, tarPath],
    workspace,
    deadline,
    signal,
  });
  throwForArchiveOutcome(compressOutcome, 'extract');
}

/**
 * `converter media <target> <file...>` - the CLI twin of `POST /media/
 * {target}`, calling `runFfmpegMedia` directly instead of going through
 * `media-jobs.service.ts`'s async job queue.
 *
 * The job queue exists in the HTTP server because a real transcode can take
 * longer than one HTTP request should stay open and the server has to answer
 * many clients at once. Locally there is one client, one process, and no
 * reason not to just wait for ffmpeg to finish - so this runs synchronously.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import {
  isMediaExtension,
  isMediaTargetId,
  MEDIA_TARGET_IDS,
  mediaTargetsFor,
  resolveMediaConversion,
  type MediaTargetId,
} from '../formats-media.ts';
import { runFfmpegMedia } from '../services/ffmpeg.service.ts';
import { Errors } from '../errors.ts';
import { createWorkspace, removeWorkspace } from '../services/workspace.service.ts';
import { extensionOf, fail, flagString, parseArgs, readInput, reportError, withExtension, writeResult } from './lib.ts';

export async function runMedia(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [target, ...inputs] = positionals;

  if (!target || inputs.length === 0) {
    fail(
      `usage: converter media <target> <file> [file2] [file3 ...] [--out <dir>]\n\n` +
        `You can pass one file, or several - they all convert to the same <target>:\n` +
        `  converter media mp3 podcast.wav\n` +
        `  converter media mp3 episode1.wav episode2.wav episode3.wav\n\n` +
        `Run "converter media --list" to see every target.`,
    );
  }

  if (target === '--list' || flags.list) {
    process.stdout.write(`${MEDIA_TARGET_IDS.join('\n')}\n`);
    return;
  }

  if (!isMediaTargetId(target)) {
    fail(`unknown media target "${target}". Run "converter media --list" to see every target.`);
  }

  const outDir = flagString(flags, 'out');

  for (const inputPath of inputs) {
    await convertOne(inputPath, target, outDir);
  }
}

async function convertOne(inputPath: string, targetId: MediaTargetId, outDir: string | undefined): Promise<void> {
  const extension = extensionOf(inputPath);
  if (!isMediaExtension(extension)) {
    fail(`"${inputPath}" has an extension (${extension || '<none>'}) the media converter does not read.`);
  }

  const target = resolveMediaConversion(extension, targetId);
  if (!target) {
    fail(
      `"${inputPath}" (${extension}) cannot become ${targetId}. It can become: ` +
        mediaTargetsFor(extension).join(', '),
    );
  }

  const data = await readInput(inputPath);
  if (data.length === 0) {
    fail(`"${inputPath}" is empty.`);
  }

  const workspace = await createWorkspace();
  try {
    const inputFile = join(workspace, `input${extension}`);
    const outputFile = join(workspace, `output${target.extension}`);
    await fsp.writeFile(inputFile, data);

    // No deadline worth enforcing locally - a real transcode can legitimately
    // run long, and there is nobody else waiting on this process.
    const outcome = await runFfmpegMedia({
      inputPath: inputFile,
      outputPath: outputFile,
      workspace,
      deadline: Date.now() + 1000 * 60 * 60 * 24,
    });

    if (outcome.kind === 'timeout') throw Errors.timeout();
    if (outcome.kind === 'aborted') throw new Error('conversion was cancelled');
    if (outcome.kind === 'exited' && (outcome.exitCode ?? -1) !== 0) {
      throw Errors.convertFailed(outcome.stderr || `ffmpeg exited ${outcome.exitCode}`);
    }

    const output = await fsp.readFile(outputFile).catch(() => {
      throw Errors.convertFailed('ffmpeg produced no output');
    });
    if (output.length === 0) throw Errors.convertFailed('ffmpeg produced an empty file');

    const downloadName = withExtension(inputPath, target.extension);
    const [written] = await writeResult([{ name: downloadName, data: output }], {
      archive: false,
      downloadName,
      outDir,
    });
    process.stdout.write(`${inputPath} -> ${written}\n`);
  } catch (error) {
    reportError(error);
  } finally {
    await removeWorkspace(workspace);
  }
}

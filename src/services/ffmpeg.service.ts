/**
 * `ffmpeg`, run as a subprocess exactly as `soffice`/`pandoc`/
 * `pdf_engine.py`/`7z` are - for two genuinely different jobs that happen
 * to share one binary:
 *
 *   - `runFfmpeg`: the image-transcode engine. `.bmp`/`.gif`/`.tiff`/
 *     `.webp`/`.avif`/`.ico`/`.png`/`.jpg`/`.jpeg` in, any of `bmp`/`gif`/
 *     `tiff`/`webp`/`avif`/`ico` out - synchronous, part of `POST /convert/
 *     {target}`'s ordinary matrix (`formats.ts`, `mode: 'transcode'`).
 *   - `runFfmpegMedia`: real audio/video transcoding for `POST /media/
 *     {target}` (`formats-media.ts`, `media-jobs.service.ts`) - asynchronous,
 *     its own job-based endpoint, for the reasons the README's Phase 5
 *     section and `config.ts`'s `MEDIA_*` constants give.
 *
 * `-frames:v 1 -update 1` IS NOT OPTIONAL for `runFfmpeg`, and is exactly
 * wrong for `runFfmpegMedia` - see each function's own comment. Without it,
 * ffmpeg's `image2` muxer treats a single output filename as the first frame
 * of an image SEQUENCE and either warns (for a source that decodes as
 * exactly one frame) or hard-fails with "Cannot write more than one file
 * with the same name" - verified by hand with a `.gif` source, which
 * decodes as a tiny video even when it has only one visible frame and
 * otherwise trips this exact error. `-frames:v 1` caps the output at one
 * frame regardless of how many the source has (a real gap this closes: an
 * animated GIF/WEBP source becomes its first frame, not a failed
 * conversion), and `-update 1` is what tells the image2 muxer this is a
 * single still image rather than a sequence at all.
 */
import { FFMPEG_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export interface FfmpegRun {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runFfmpeg(run: FfmpegRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: FFMPEG_BIN,
    args: [
      '-y',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-update',
      '1',
      outputPath,
    ],
    workspace,
    deadline,
    signal,
  });
}

/**
 * Real audio/video transcoding for `POST /media/{target}` - see
 * `media-jobs.service.ts`. No `-frames:v 1`/`-update 1`: those exist
 * specifically to force a STILL image out of a source ffmpeg might decode
 * as a tiny video, which is exactly wrong here - a media job's whole point
 * is to keep every frame (and every audio sample) of a real recording,
 * however long it runs. Every other concern - deadline, abort, process-group
 * kill on timeout - is identical to `runFfmpeg`'s, so this reuses the same
 * `runProcess` rather than a third copy of the subprocess plumbing.
 */
export function runFfmpegMedia(run: FfmpegRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: FFMPEG_BIN,
    args: ['-y', '-i', inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

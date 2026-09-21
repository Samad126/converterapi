/**
 * The image-transcode engine: `.bmp`/`.gif`/`.tiff`/`.webp`/`.avif`/`.ico`/
 * `.png`/`.jpg`/`.jpeg` in, any of `bmp`/`gif`/`tiff`/`webp`/`avif`/`ico` out.
 * A fifth conversion engine, running `ffmpeg` as a subprocess exactly as
 * `soffice`/`pandoc`/`pdf_engine.py`/`7z` are.
 *
 * `-frames:v 1 -update 1` IS NOT OPTIONAL. Without it, ffmpeg's `image2`
 * muxer treats a single output filename as the first frame of an image
 * SEQUENCE and either warns (for a source that decodes as exactly one
 * frame) or hard-fails with "Cannot write more than one file with the same
 * name" - verified by hand with a `.gif` source, which decodes as a tiny
 * video even when it has only one visible frame and otherwise trips this
 * exact error. `-frames:v 1` caps the output at one frame regardless of how
 * many the source has (a real gap this closes: an animated GIF/WEBP source
 * becomes its first frame, not a failed conversion), and `-update 1` is
 * what tells the image2 muxer this is a single still image rather than a
 * sequence at all.
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

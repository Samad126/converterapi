/**
 * `libheif`'s two CLI tools, run as subprocesses exactly as `ffmpeg`/
 * `soffice`/`7z` are - for `.heic`/`.heif` in EITHER direction, the one pair
 * this build's `ffmpeg` cannot reach at all (verified by hand: `ffmpeg
 * -demuxers`/`-decoders` list no `heif` entry, so there is no zero-flag
 * `ffmpeg -i in out` that would ever work here). See `formats.ts`'s
 * `TargetFormat.mode` doc comment (`'heif'` bullet) for the routing this
 * exists to serve.
 *
 * `heif-convert <in> <out>` DECODES a `.heic`/`.heif` source. It picks its
 * output format from the OUTPUT filename's own extension - verified by hand
 * against a real HEIC file - and recognises `jpg`/`jpeg`/`png`/`tif`/`tiff`
 * directly, which is every one of this service's `TRANSCODE_TARGETS` that
 * are not `bmp`/`gif`/`webp`/`avif`/`ico`. Those five go through an
 * intermediate PNG instead (`runHeifDecode` always writes one), which
 * `runFfmpegPipeline`'s own `runFfmpeg` then transcodes onward exactly as it
 * would for a `.png` upload - one extra process, not a new code path.
 *
 * `heif-enc <in> -o <out>` ENCODES a `.heic`/`.heif` target, but only reads
 * PNG or JPEG (verified by hand: a `.bmp` input fails with "Not a JPEG
 * file"), so a source that is not already one of those two is first
 * transcoded to an intermediate PNG via `runFfmpeg` - the very same `ffmpeg`
 * step `TRANSCODE_TARGETS` sources already use for everything else, just run
 * one step earlier here.
 */
import { HEIF_CONVERT_BIN, HEIF_ENC_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export interface HeifRun {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/** Decode a `.heic`/`.heif` source into whatever format `outputPath`'s own extension names. */
export function runHeifDecode(run: HeifRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: HEIF_CONVERT_BIN,
    args: [inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}

/** Encode a PNG/JPEG source into `.heic`/`.heif` - `outputPath` must end in one of those two. */
export function runHeifEncode(run: HeifRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: HEIF_ENC_BIN,
    args: ['-o', outputPath, inputPath],
    workspace,
    deadline,
    signal,
  });
}

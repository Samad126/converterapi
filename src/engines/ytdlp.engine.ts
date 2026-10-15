/**
 * `yt-dlp`, run as a subprocess the same way every other engine is - and the
 * only engine here that reaches the network. It downloads a YouTube video and
 * leaves the finished file at a path this service chose, for
 * `POST /youtube/{target}` (`services/youtube.service.ts` owns the job logic).
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 *   - The URL is always the canonical watch URL `parseYouTubeUrl` built, never
 *     client text, and it goes after `--` so nothing in it can be read as an
 *     option. See `lib/youtube-url.ts` for why `yt-dlp` is never given more.
 *   - `--ignore-config` and `--no-cache-dir`: `yt-dlp` must not read a config
 *     file or write a cache anywhere but this job's own workspace.
 *
 * The format selector prefers H.264 in MP4 over the newer codecs YouTube also
 * serves. Left to its own defaults, `yt-dlp` picked AV1 in MP4 for a real
 * video, and AV1 does not play on many phones and older browsers - the
 * Android client is exactly that audience. H.264 is the fallback order, not
 * a hard requirement: a 4K video that exists only as VP9/AV1 still converts.
 *
 * `yt-dlp` exits `0` in some failures that leave no file behind - a file over
 * `--max-filesize`, or a live stream skipped by `--match-filter` - so the
 * caller must check the output on disk and the messages it printed, never the
 * exit code alone. See `youtube.service.ts`.
 */
import { extname, isAbsolute } from 'node:path';

import { FFMPEG_BIN, YOUTUBE_MAX_FILESIZE_BYTES, YTDLP_BIN } from '../config.ts';
import type { YouTubeTargetId } from '../lib/youtube-url.ts';
import { runProcess, type ProcessOutcome } from './soffice.engine.ts';

export interface YtDlpRun {
  /** The canonical watch URL from `parseYouTubeUrl` - never client text. */
  url: string;
  target: YouTubeTargetId;
  /** Exactly where the finished file must end up, extension included. */
  outputPath: string;
  /** Where `yt-dlp` writes the video's title, read back for the download name. */
  titlePath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/** H.264 video in MP4 with AAC audio first; then the looser fallbacks in order. */
const MP4_FORMAT_SELECTOR = [
  'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]',
  'b[ext=mp4][vcodec^=avc1]',
  'bv*[ext=mp4]+ba[ext=m4a]',
  'b[ext=mp4]',
  'bv*+ba',
  'b',
].join('/');

/** The argument list for one download. Pure, so the contract is testable without the network. */
export function buildYtDlpArgs(run: Omit<YtDlpRun, 'workspace' | 'deadline' | 'signal'>): string[] {
  const { url, target, outputPath, titlePath } = run;

  // yt-dlp's `-o` is a template: `%` starts a field. The output directory is
  // ours, but a configured TEMP root could contain one, so it is escaped.
  const stem = outputPath.slice(0, outputPath.length - extname(outputPath).length);
  const template = `${stem.replace(/%/g, '%%')}.%(ext)s`;

  const args = [
    '--ignore-config',
    '--no-cache-dir',
    '--no-playlist',
    '--no-progress',
    '--socket-timeout',
    '30',
    // The one JavaScript runtime YouTube's current challenge solver needs,
    // pinned to this exact node binary so no PATH lookup is involved.
    '--js-runtimes',
    `node:${process.execPath}`,
    // A live stream would otherwise be recorded until the job's timeout.
    '--match-filter',
    '!is_live',
    '--max-filesize',
    String(YOUTUBE_MAX_FILESIZE_BYTES),
    '-f',
    target === 'mp4' ? MP4_FORMAT_SELECTOR : 'ba/b',
    '-o',
    template,
    '--print-to-file',
    'after_move:%(title)s',
    titlePath,
  ];

  // Only an absolute FFMPEG_BIN is handed over: a bare name is already found
  // through PATH, the same way yt-dlp would find it anyway.
  if (isAbsolute(FFMPEG_BIN)) args.push('--ffmpeg-location', FFMPEG_BIN);

  if (target === 'mp4') {
    args.push('--merge-output-format', 'mp4');
  } else {
    // `-x` extracts the audio track; quality 0 is the encoder's best VBR.
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  // Everything after `--` is a positional argument, even one that starts with
  // a dash. The canonical URL starts with `https://` so this is belt and braces.
  args.push('--', url);
  return args;
}

export function runYtDlp(run: YtDlpRun): Promise<ProcessOutcome> {
  const { workspace, deadline, signal } = run;

  return runProcess({
    bin: YTDLP_BIN,
    args: buildYtDlpArgs(run),
    workspace,
    deadline,
    signal,
    // Kept, not discarded: the only proof that a file was skipped for being
    // too large or for being live is a line yt-dlp prints to stdout.
    captureStdout: true,
  });
}

/**
 * One YouTube download, from `yt-dlp`'s output to a finished file - or to one
 * specific, honest error.
 *
 * `yt-dlp` does not report failure the way the rest of this service expects.
 * An oversized video and a skipped live stream both exit `0` and leave no
 * file, and the only thing that tells them apart from success is a line of
 * text it printed. So the outcome is decided here from two things together:
 * the exit code, and whether the file is actually on disk. The text is then
 * read only to choose which sentence the person is shown.
 */
import fsp from 'node:fs/promises';

import { runYtDlp } from '../engines/ytdlp.engine.ts';
import { AppError, Errors } from '../errors.ts';
import { downloadNameForTitle } from '../lib/download-name.ts';
import { mediaFormat } from '../formats-media.ts';
import type { YouTubeTargetId } from '../lib/youtube-url.ts';
import { YOUTUBE_MAX_FILESIZE_BYTES } from '../config.ts';

export interface YouTubeDownloadRun {
  /** The canonical watch URL, from `parseYouTubeUrl`. */
  url: string;
  videoId: string;
  target: YouTubeTargetId;
  workspace: string;
  outputPath: string;
  titlePath: string;
  deadline: number;
  signal?: AbortSignal;
}

/** yt-dlp's own wording for a file it refused because it is over the size limit. */
const TOO_LARGE_LINE = /larger than max-filesize/i;
/** The `--match-filter` skip line for a stream that is still live. */
const LIVE_LINE = /does not pass filter \(is_live\)/i;
/**
 * yt-dlp's wording for a video that exists but may not be fetched. Each
 * pattern is a distinct cause YouTube reports; a bot-check ("Sign in to
 * confirm you're not a bot") is deliberately NOT here, because that one is
 * about this server, not about the video.
 */
const UNAVAILABLE_LINES: readonly RegExp[] = [
  /video is unavailable/i,
  /this video is not available/i,
  /private video/i,
  /video has been removed/i,
  /removed by the uploader/i,
  /available in your country/i,
  /copyright grounds/i,
  /confirm your age/i,
  /members[- ]only/i,
  /join this channel/i,
  /account (?:has been )?terminated/i,
];

/**
 * Download `run.url` to `run.outputPath`, and return the name to offer it
 * under. Throws an `AppError` for every way this can fail.
 */
export async function downloadYouTubeVideo(run: YouTubeDownloadRun): Promise<string> {
  const { url, videoId, target, workspace, outputPath, titlePath, deadline, signal } = run;

  const outcome = await runYtDlp({
    url,
    target,
    outputPath,
    titlePath,
    workspace,
    deadline,
    signal,
  });

  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') {
    // Unreachable in practice - no `signal` is passed to a background job - but
    // `ProcessOutcome` still has to be narrowed.
    throw Errors.internal('youtube download aborted with no signal');
  }

  const stat = await fsp.stat(outputPath).catch(() => null);
  if (outcome.exitCode === 0 && stat && stat.size > 0) {
    // yt-dlp checks each stream against the limit, not the merged file, so the
    // finished file is checked too.
    if (stat.size > YOUTUBE_MAX_FILESIZE_BYTES) {
      throw Errors.videoTooLarge(YOUTUBE_MAX_FILESIZE_BYTES);
    }
    const title = await readTitle(titlePath, videoId);
    return downloadNameForTitle(title, mediaFormat(target).extension);
  }

  const diagnostics = `${outcome.stderr}\n${outcome.stdout ?? ''}`;
  throw youtubeFailureFor(diagnostics, outcome.exitCode);
}

/**
 * The one error to report for a download that produced no usable file.
 *
 * Checked in order of how specific the cause is: the size and live-stream
 * lines are unambiguous, the unavailable reasons are next, and anything else
 * is reported generically with the full text kept for the logs.
 */
export function youtubeFailureFor(diagnostics: string, exitCode: number | null): AppError {
  if (TOO_LARGE_LINE.test(diagnostics)) return Errors.videoTooLarge(YOUTUBE_MAX_FILESIZE_BYTES);
  if (LIVE_LINE.test(diagnostics)) return Errors.videoLive();
  if (UNAVAILABLE_LINES.some((pattern) => pattern.test(diagnostics))) {
    return Errors.videoUnavailable();
  }
  return Errors.youtubeDownloadFailed(
    new Error(`yt-dlp exited ${exitCode ?? 'with no code'}: ${diagnostics.trim().slice(-2_000)}`),
  );
}

/**
 * The video's title, as yt-dlp wrote it, or the video id if that file is
 * missing or empty. A title is only a nicer name - a missing one must never
 * fail a download that worked.
 */
async function readTitle(titlePath: string, fallback: string): Promise<string> {
  try {
    const first = (await fsp.readFile(titlePath, 'utf8')).split('\n')[0]?.trim();
    return first ? first : fallback;
  } catch {
    return fallback;
  }
}

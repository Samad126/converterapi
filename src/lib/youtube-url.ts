/**
 * Turning whatever a client pasted into one canonical YouTube watch URL, or
 * refusing it.
 *
 * This is the boundary that keeps `yt-dlp` from being a general-purpose
 * downloader. `yt-dlp` understands hundreds of sites, and handing it a URL
 * the client typed would make this service a fetcher for every one of them -
 * and for `file://`-style and internal-address tricks besides. So nothing
 * the client sent reaches the subprocess. The client's string is parsed here,
 * the 11-character video id is extracted and checked against YouTube's own id
 * alphabet, and `yt-dlp` is only ever given `https://www.youtube.com/watch?v=<id>`
 * built from that id. Playlists, timestamps and credentials in the input are
 * dropped on purpose: the canonical form names exactly one video.
 */

/** The two ways a YouTube video can leave this service. */
export const YOUTUBE_TARGET_IDS = ['mp4', 'mp3'] as const;
export type YouTubeTargetId = (typeof YOUTUBE_TARGET_IDS)[number];

export function isYouTubeTargetId(id: string): id is YouTubeTargetId {
  return (YOUTUBE_TARGET_IDS as readonly string[]).includes(id);
}

export interface YouTubeVideo {
  /** The 11-character id YouTube assigns the video. */
  readonly videoId: string;
  /** The only URL that is ever handed to `yt-dlp`. */
  readonly canonicalUrl: string;
}

/** Hosts a YouTube video link can use. Anything else is refused, not fetched. */
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

/** Path prefixes that name a single video by its id as the next segment. */
const ID_IN_PATH_PREFIXES: ReadonlySet<string> = new Set(['shorts', 'embed', 'live']);

/** YouTube's id alphabet, and its fixed length. Anything else is not a video id. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video a pasted link names, or `null` if it names no YouTube video.
 *
 * Accepts the forms people actually copy: `watch?v=`, `youtu.be/`, `/shorts/`,
 * `/embed/` and `/live/`, on the desktop, mobile and music hosts. Returns
 * `null` rather than throwing - the caller turns that into one sentence for
 * the person holding the phone.
 */
export function parseYouTubeUrl(raw: string): YouTubeVideo | null {
  // People copy `youtube.com/watch?v=...` without the scheme. Anything that does
  // not already name a scheme gets https:// in front, and the protocol check
  // below still refuses every non-web scheme.
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter((segment) => segment !== '');

  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = segments[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') {
      videoId = url.searchParams.get('v');
    } else if (segments[0] !== undefined && ID_IN_PATH_PREFIXES.has(segments[0])) {
      videoId = segments[1] ?? null;
    }
  } else {
    return null;
  }

  if (videoId === null || !VIDEO_ID.test(videoId)) return null;
  return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

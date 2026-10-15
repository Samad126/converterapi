/**
 * The YouTube path below the HTTP layer: which links are accepted, the exact
 * argument list `yt-dlp` is run with, and how a `yt-dlp` failure is turned into
 * the one sentence the person sees. Pure functions only - no network, no
 * subprocess. The real download is covered by `test/integration/convert/
 * youtube.test.ts` (against a stand-in `yt-dlp`) and `youtube-live.test.ts`
 * (against YouTube itself, opt-in).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { YOUTUBE_MAX_FILESIZE_BYTES } from '../../src/config.ts';
import { buildYtDlpArgs } from '../../src/engines/ytdlp.engine.ts';
import { downloadNameForTitle } from '../../src/lib/download-name.ts';
import { isYouTubeTargetId, parseYouTubeUrl } from '../../src/lib/youtube-url.ts';
import { youtubeFailureFor } from '../../src/services/youtube.service.ts';

const VIDEO = 'jNQXAC9IVRw';
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO}`;

describe('parseYouTubeUrl', () => {
  it('accepts the forms people actually copy, and canonicalises each to one watch URL', () => {
    const accepted = [
      `https://www.youtube.com/watch?v=${VIDEO}`,
      `https://youtube.com/watch?v=${VIDEO}`,
      `https://m.youtube.com/watch?v=${VIDEO}`,
      `https://music.youtube.com/watch?v=${VIDEO}`,
      `https://youtu.be/${VIDEO}`,
      `https://youtu.be/${VIDEO}?si=abcDEF123`,
      `https://www.youtube.com/shorts/${VIDEO}`,
      `https://www.youtube.com/embed/${VIDEO}`,
      `https://www.youtube.com/live/${VIDEO}`,
      `http://www.youtube.com/watch?v=${VIDEO}`,
      `  https://www.youtube.com/watch?v=${VIDEO}  `,
      `www.youtube.com/watch?v=${VIDEO}`,
    ];
    for (const input of accepted) {
      assert.deepEqual(parseYouTubeUrl(input), { videoId: VIDEO, canonicalUrl: CANONICAL }, input);
    }
  });

  it('reduces a playlist or timestamp link to the one video it names', () => {
    const video = parseYouTubeUrl(
      `https://www.youtube.com/watch?v=${VIDEO}&list=PLexample0000000000&t=42s`,
    );
    assert.deepEqual(video, { videoId: VIDEO, canonicalUrl: CANONICAL });
  });

  it('drops credentials from the input rather than passing them on', () => {
    const video = parseYouTubeUrl(`https://user:secret@www.youtube.com/watch?v=${VIDEO}`);
    assert.equal(video?.canonicalUrl, CANONICAL);
  });

  it('accepts an id that starts with a dash, because the canonical URL keeps it after https://', () => {
    const video = parseYouTubeUrl('https://youtu.be/-abcdefghij');
    assert.deepEqual(video, {
      videoId: '-abcdefghij',
      canonicalUrl: 'https://www.youtube.com/watch?v=-abcdefghij',
    });
  });

  it('refuses any host that is not a YouTube host, even one that looks like it', () => {
    const refused = [
      `https://evil.example/watch?v=${VIDEO}`,
      `https://www.youtube.com.evil.example/watch?v=${VIDEO}`,
      `https://evilyoutube.com/watch?v=${VIDEO}`,
      `https://www.youtube-nocookie.com/embed/${VIDEO}`,
      `https://127.0.0.1/watch?v=${VIDEO}`,
      `https://localhost/watch?v=${VIDEO}`,
    ];
    for (const input of refused) {
      assert.equal(parseYouTubeUrl(input), null, input);
    }
  });

  it('refuses non-web schemes, which yt-dlp would otherwise be happy to read', () => {
    assert.equal(parseYouTubeUrl(`file:///etc/passwd`), null);
    assert.equal(parseYouTubeUrl(`ftp://www.youtube.com/watch?v=${VIDEO}`), null);
  });

  it('refuses anything that is not exactly one 11-character YouTube id', () => {
    const refused = [
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw1',
      'https://www.youtube.com/watch?v=jNQXAC9IV;rm',
      'https://www.youtube.com/watch?v=jNQXAC9IV%20',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
      'https://www.youtube.com/@somechannel',
      'https://youtu.be/',
    ];
    for (const input of refused) {
      assert.equal(parseYouTubeUrl(input), null, input);
    }
  });

  it('returns null rather than throwing for text that is not a URL at all', () => {
    assert.equal(parseYouTubeUrl(''), null);
    assert.equal(parseYouTubeUrl('not a url'), null);
    assert.equal(parseYouTubeUrl('https://'), null);
  });
});

describe('isYouTubeTargetId', () => {
  it('accepts exactly mp4 and mp3', () => {
    assert.equal(isYouTubeTargetId('mp4'), true);
    assert.equal(isYouTubeTargetId('mp3'), true);
    assert.equal(isYouTubeTargetId('wav'), false);
    assert.equal(isYouTubeTargetId('MP4'), false);
    assert.equal(isYouTubeTargetId('__proto__'), false);
  });
});

describe('buildYtDlpArgs', () => {
  const base = {
    url: CANONICAL,
    outputPath: '/work/job-1/out/converted.mp4',
    titlePath: '/work/job-1/title.txt',
  };

  it('always passes the URL last, after --, and never anything the client typed', () => {
    for (const target of ['mp4', 'mp3'] as const) {
      const args = buildYtDlpArgs({ ...base, target });
      assert.deepEqual(args.slice(-2), ['--', CANONICAL], target);
    }
  });

  it('keeps yt-dlp inside its own workspace and off any config file or cache', () => {
    const args = buildYtDlpArgs({ ...base, target: 'mp4' });
    assert.ok(args.includes('--ignore-config'));
    assert.ok(args.includes('--no-cache-dir'));
    assert.ok(args.includes('--no-playlist'));
  });

  it('skips live streams and enforces the size limit before downloading', () => {
    const args = buildYtDlpArgs({ ...base, target: 'mp4' });
    assert.equal(args[args.indexOf('--match-filter') + 1], '!is_live');
    assert.equal(args[args.indexOf('--max-filesize') + 1], String(YOUTUBE_MAX_FILESIZE_BYTES));
  });

  it('writes the title to the given file and the video to the given stem', () => {
    const args = buildYtDlpArgs({ ...base, target: 'mp4' });
    assert.equal(args[args.indexOf('--print-to-file') + 1], 'after_move:%(title)s');
    assert.equal(args[args.indexOf('--print-to-file') + 2], '/work/job-1/title.txt');
    assert.equal(args[args.indexOf('-o') + 1], '/work/job-1/out/converted.%(ext)s');
  });

  it('escapes a % in the output path so yt-dlp does not read it as a template field', () => {
    const args = buildYtDlpArgs({ ...base, outputPath: '/work/50%/out/converted.mp4', target: 'mp4' });
    assert.equal(args[args.indexOf('-o') + 1], '/work/50%%/out/converted.%(ext)s');
  });

  it('pins the JavaScript runtime to this node binary, not a PATH lookup', () => {
    const args = buildYtDlpArgs({ ...base, target: 'mp4' });
    assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  });

  it('for mp4: prefers H.264 in MP4 and merges to an MP4 container', () => {
    const args = buildYtDlpArgs({ ...base, target: 'mp4' });
    const selector = args[args.indexOf('-f') + 1] ?? '';
    assert.ok(selector.startsWith('bv*[ext=mp4][vcodec^=avc1]'), selector);
    assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
    assert.ok(!args.includes('-x'), 'mp4 must not be an audio extraction');
  });

  it('for mp3: extracts the audio track and transcodes it to mp3', () => {
    const args = buildYtDlpArgs({ ...base, outputPath: '/work/job-1/out/converted.mp3', target: 'mp3' });
    assert.ok(args.includes('-x'));
    assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
    assert.equal(args[args.indexOf('-f') + 1], 'ba/b');
    assert.ok(!args.includes('--merge-output-format'));
  });
});

describe('youtubeFailureFor', () => {
  const bytes = YOUTUBE_MAX_FILESIZE_BYTES;

  it('reports an oversized video as too large, with the real limit in the sentence', () => {
    const error = youtubeFailureFor(
      '[download] File is larger than max-filesize (433081 bytes > 102400 bytes). Aborting.',
      0,
    );
    assert.equal(error.code, 'E_TOO_LARGE');
    assert.equal(error.status, 413);
    assert.equal(
      error.userMessage,
      `This video is larger than the ${Math.floor(bytes / (1024 * 1024))} MB limit.`,
    );
  });

  it('reports a live stream as a live stream, not as a generic failure', () => {
    const error = youtubeFailureFor(
      '[download] Me at the zoo does not pass filter (is_live), skipping ..',
      0,
    );
    assert.equal(error.code, 'E_VIDEO_UNAVAILABLE');
    assert.equal(error.userMessage, 'This video is a live stream. Try again once it has ended.');
  });

  it('reports a private, removed, age-restricted or geo-blocked video as unavailable', () => {
    const messages = [
      'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable',
      'ERROR: [youtube] x: Private video. Sign in if you have access',
      'ERROR: [youtube] x: This video has been removed by the uploader',
      'ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate',
      'ERROR: [youtube] x: The uploader has not made this video available in your country',
      'ERROR: [youtube] x: This video is members-only content. Join this channel to get access',
    ];
    for (const diagnostics of messages) {
      const error = youtubeFailureFor(diagnostics, 1);
      assert.equal(error.code, 'E_VIDEO_UNAVAILABLE', diagnostics);
      assert.equal(error.status, 422, diagnostics);
    }
  });

  it('does not blame the video for a YouTube bot-check, which is about this server', () => {
    const error = youtubeFailureFor(
      "ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies",
      1,
    );
    assert.equal(error.code, 'E_CONVERT_FAILED');
    assert.equal(error.status, 500);
    assert.equal(error.userMessage, 'This video could not be downloaded. Try again in a few minutes.');
  });

  it('keeps yt-dlp\'s own text for the logs, without putting it in the message', () => {
    const error = youtubeFailureFor('ERROR: unable to download webpage: timed out', 1);
    assert.match(String(error.cause), /unable to download webpage/);
    assert.ok(!error.userMessage.includes('yt-dlp'));
  });
});

describe('downloadNameForTitle', () => {
  it('names the download after the title, with the target extension', () => {
    assert.equal(downloadNameForTitle('Me at the zoo', '.mp4'), 'Me at the zoo.mp4');
  });

  it('keeps dots that belong to the title and drops nothing but the extension', () => {
    assert.equal(downloadNameForTitle('Mr. Robot S01E01. Pilot', '.mp3'), 'Mr. Robot S01E01. Pilot.mp3');
  });

  it('turns a slash in a title into a dash rather than a path separator', () => {
    assert.equal(downloadNameForTitle('AC/DC - Thunderstruck', '.mp3'), 'AC-DC - Thunderstruck.mp3');
  });

  it('strips control characters and quotes that would break a header', () => {
    const name = downloadNameForTitle('Bad\r\nname "quoted"', '.mp4');
    assert.ok(!/[\r\n"]/.test(name), name);
    assert.ok(name.endsWith('.mp4'));
  });

  it('falls back to a generic name when the title leaves nothing usable', () => {
    assert.equal(downloadNameForTitle('\u0000\u0001', '.mp3'), 'converted.mp3');
  });
});

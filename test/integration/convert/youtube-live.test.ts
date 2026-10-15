/**
 * `POST /youtube/{target}` against YouTube itself, with the real yt-dlp and
 * the real ffmpeg. The only test here that proves a download actually works.
 *
 * Opt-in, because it needs network access to YouTube, and YouTube changes often
 * enough that a failure here usually means "yt-dlp is out of date", not "this
 * service is broken". Run it with the binaries you mean to test:
 *
 *   YOUTUBE_LIVE_TEST=1 YTDLP_BIN=/path/to/yt-dlp FFMPEG_BIN=/path/to/ffmpeg \
 *     node --test --experimental-strip-types test/integration/convert/youtube-live.test.ts
 *
 * The video is the first one ever uploaded to YouTube, 19 seconds long.
 */
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadMediaJob,
  pollMediaJob,
  startTestServer,
  type TestServer,
} from '../../support/helpers.ts';

const LIVE = process.env.YOUTUBE_LIVE_TEST === '1';
const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

let server: TestServer;

before(async () => {
  if (!LIVE) return;
  server = await startTestServer();
});

after(async () => {
  if (!LIVE) return;
  await server.close();
});

async function convertLive(target: 'mp4' | 'mp3') {
  const response = await fetch(`${server.baseUrl}/youtube/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: VIDEO_URL }),
  });
  assert.equal(response.status, 202);
  const accepted = (await response.json()) as { id: string };
  return pollMediaJob(server.baseUrl, accepted.id, 5 * 60_000).then((settled) => ({
    settled,
    id: accepted.id,
  }));
}

describe('POST /youtube/{target} against YouTube', { skip: LIVE ? false : 'set YOUTUBE_LIVE_TEST=1 to run' }, () => {
  it('downloads a real video as an MP4 with H.264 video, named after its title', async () => {
    const { settled, id } = await convertLive('mp4');
    assert.equal(settled.status, 'done', JSON.stringify(settled.error));

    const download = await downloadMediaJob(server.baseUrl, id);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'video/mp4');
    assert.match(download.contentDisposition ?? '', /filename="Me at the zoo\.mp4"/);

    // A real MP4: an `ftyp` box straight after the 4-byte size field.
    assert.equal(download.body.subarray(4, 8).toString('ascii'), 'ftyp');
    // H.264 is what the format selector asks for first; its sample entry is `avc1`.
    assert.ok(download.body.includes(Buffer.from('avc1')), 'expected an H.264 (avc1) video track');
  });

  it('extracts a real MP3 from the same video', async () => {
    const { settled, id } = await convertLive('mp3');
    assert.equal(settled.status, 'done', JSON.stringify(settled.error));

    const download = await downloadMediaJob(server.baseUrl, id);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/mpeg');
    assert.match(download.contentDisposition ?? '', /filename="Me at the zoo\.mp3"/);

    // A real MP3: an ID3v2 tag, or a raw MPEG audio frame sync word.
    const head = download.body.subarray(0, 3).toString('latin1');
    assert.ok(head === 'ID3' || download.body[0] === 0xff, 'not a real MP3');
  });
});

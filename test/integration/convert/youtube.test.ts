/**
 * `POST /youtube/{target}` end to end - accept, poll, download - against a
 * STAND-IN `yt-dlp`, so it needs no network and no YouTube.
 *
 * The stand-in is a small script placed first on PATH. It records the exact
 * argv it was run with (so the tests can check what the service asks of
 * yt-dlp) and then writes a file, or fails, as the test's mode asks. Whether
 * the real yt-dlp can still download a current video is a different question,
 * answered by `youtube-live.test.ts` when opted into.
 *
 * The stand-in is only used when YTDLP_BIN is unset - the service reads that
 * once, at import, so it cannot be redirected per test. With it set, this file
 * is skipped rather than silently testing the wrong binary.
 */
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { downloadMediaJob, pollMediaJob, startTestServer, type TestServer } from '../../support/helpers.ts';

const VIDEO = 'jNQXAC9IVRw';
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO}`;

/**
 * Written as a real executable. For each run it appends its argv to a log,
 * then acts on FAKE_YTDLP_MODE: `ok` writes the requested output and title;
 * the other modes reproduce the lines real yt-dlp prints for each failure.
 */
const STAND_IN_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_YTDLP_MODE || 'ok';
if (mode === 'unavailable') {
  console.error('ERROR: [youtube] x: This video is unavailable');
  process.exit(1);
}
if (mode === 'fail') {
  console.error('ERROR: unable to download webpage: connection reset');
  process.exit(1);
}
if (mode === 'too-large') {
  console.log('[download] File is larger than max-filesize (433081 bytes > 1 bytes). Aborting.');
  process.exit(0);
}
if (mode === 'live') {
  console.log('[download] Me at the zoo does not pass filter (is_live), skipping ..');
  process.exit(0);
}
if (mode === 'nothing') {
  process.exit(0);
}
const template = args[args.indexOf('-o') + 1];
const ext = args.includes('-x') ? 'mp3' : 'mp4';
fs.writeFileSync(template.replace('%(ext)s', ext), Buffer.alloc(4096, 7));
fs.writeFileSync(args[args.indexOf('--print-to-file') + 2], 'Fake Title\\n');
`;

const usingStandIn = process.env.YTDLP_BIN === undefined;

let server: TestServer;
let standInDir: string;
let argvLog: string;
const savedPath = process.env.PATH;

async function readArgvLog(): Promise<string[][]> {
  const text = await fsp.readFile(argvLog, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

function setMode(mode: string): void {
  process.env.FAKE_YTDLP_MODE = mode;
}

/** POST a body to `/youtube/<target>`. Strings go as-is; anything else as JSON. */
async function postYouTube(
  target: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await fetch(`${server.baseUrl}/youtube/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Start a job and wait for it to settle, returning the settled status body. */
async function runJob(target: string, url: string): Promise<Record<string, unknown>> {
  const accepted = await postYouTube(target, { url });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  return pollMediaJob(server.baseUrl, accepted.body.id as string);
}

before(async () => {
  if (!usingStandIn) return;
  standInDir = await fsp.mkdtemp(join(tmpdir(), 'stand-in-ytdlp-'));
  await fsp.writeFile(join(standInDir, 'yt-dlp'), STAND_IN_SOURCE, { mode: 0o755 });
  argvLog = join(standInDir, 'argv.log');
  process.env.PATH = `${standInDir}${delimiter}${savedPath ?? ''}`;
  process.env.FAKE_YTDLP_LOG = argvLog;
  server = await startTestServer();
});

after(async () => {
  if (!usingStandIn) return;
  await server.close();
  process.env.PATH = savedPath;
  delete process.env.FAKE_YTDLP_MODE;
  delete process.env.FAKE_YTDLP_LOG;
  await fsp.rm(standInDir, { recursive: true, force: true }).catch(() => {});
});

describe('POST /youtube/{target}', { skip: usingStandIn ? false : 'YTDLP_BIN is set, so the stand-in yt-dlp would not be used' }, () => {
  it('downloads a video and offers it back as a named MP4', async () => {
    setMode('ok');
    const accepted = await postYouTube('mp4', { url: CANONICAL });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, 'queued');
    assert.equal(accepted.body.statusUrl, `/media/jobs/${accepted.body.id as string}`);

    const finished = await pollMediaJob(server.baseUrl, accepted.body.id as string);
    assert.equal(finished.status, 'done');
    assert.equal(finished.target, 'mp4');
    assert.equal(finished.downloadUrl, `/media/jobs/${accepted.body.id as string}/download`);

    const download = await downloadMediaJob(server.baseUrl, accepted.body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'video/mp4');
    assert.match(download.contentDisposition ?? '', /filename="Fake Title\.mp4"/);
    assert.ok(download.body.length > 0);
  });

  it('asks yt-dlp for an H.264 MP4 with the canonical URL last, after --', async () => {
    setMode('ok');
    const before = (await readArgvLog()).length;
    await runJob('mp4', CANONICAL);

    const run = (await readArgvLog()).slice(before);
    assert.equal(run.length, 1, 'exactly one yt-dlp run per job');
    const args = run[0]!;
    assert.deepEqual(args.slice(-2), ['--', CANONICAL]);
    assert.match(args[args.indexOf('-f') + 1] ?? '', /^bv\*\[ext=mp4\]\[vcodec\^=avc1\]/);
    assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
    assert.ok(!args.includes('-x'));
  });

  it('extracts the audio of the same kind of link as a named MP3', async () => {
    setMode('ok');
    const settled = await runJob('mp3', CANONICAL);
    assert.equal(settled.status, 'done');
    assert.equal(settled.target, 'mp3');

    const download = await downloadMediaJob(server.baseUrl, settled.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/mpeg');
    assert.match(download.contentDisposition ?? '', /filename="Fake Title\.mp3"/);

    const run = (await readArgvLog()).at(-1)!;
    assert.ok(run.includes('-x'));
    assert.equal(run[run.indexOf('--audio-format') + 1], 'mp3');
  });

  it('gives yt-dlp the canonical watch URL even when the client sent a messier one', async () => {
    setMode('ok');
    const before = (await readArgvLog()).length;
    const settled = await runJob('mp4', `https://youtu.be/${VIDEO}?si=x&list=PLexample0000000000&t=9`);
    assert.equal(settled.status, 'done');

    const run = (await readArgvLog()).slice(before);
    assert.deepEqual(run[0]?.slice(-2), ['--', CANONICAL]);
  });

  it('refuses a link that is not a YouTube video, and never starts yt-dlp for it', async () => {
    const before = (await readArgvLog()).length;
    const { status, body } = await postYouTube('mp4', { url: 'https://evil.example/watch?v=jNQXAC9IVRw' });
    assert.equal(status, 400);
    assert.deepEqual(body, {
      error: { code: 'E_INVALID_FIELD', message: 'That is not a YouTube video link.' },
    });
    assert.equal((await readArgvLog()).length, before);
  });

  it('refuses a target that is not mp4 or mp3 before reading the body', async () => {
    const { status, body } = await postYouTube('wav', { url: CANONICAL });
    assert.equal(status, 404);
    assert.deepEqual(body, {
      error: { code: 'E_UNKNOWN_TARGET', message: 'YouTube videos can only be converted to MP4 or MP3.' },
    });
  });

  it('refuses a body that is not JSON, with the one sentence that says what to send', async () => {
    const { status, body } = await postYouTube('mp4', '{"url": ');
    assert.equal(status, 400);
    assert.deepEqual(body, {
      error: {
        code: 'E_INVALID_FIELD',
        message: 'Send the link as JSON, like {"url": "https://www.youtube.com/watch?v=..."}.',
      },
    });
  });

  it('refuses a JSON body with no url in it', async () => {
    const { status, body } = await postYouTube('mp4', { link: CANONICAL });
    assert.equal(status, 400);
    assert.equal((body.error as { code: string }).code, 'E_INVALID_FIELD');
  });

  it('reports a private, removed or otherwise unavailable video as E_VIDEO_UNAVAILABLE', async () => {
    setMode('unavailable');
    const settled = await runJob('mp4', CANONICAL);
    assert.equal(settled.status, 'failed');
    assert.deepEqual(settled.error, {
      code: 'E_VIDEO_UNAVAILABLE',
      message: 'This video is private, removed, age-restricted, or not available in this country.',
    });

    const download = await downloadMediaJob(server.baseUrl, settled.id as string);
    assert.equal(download.status, 422);
    assert.equal(JSON.parse(download.body.toString('utf8')).error.code, 'E_VIDEO_UNAVAILABLE');
  });

  it('reports a live stream as a live stream', async () => {
    setMode('live');
    const settled = await runJob('mp4', CANONICAL);
    assert.equal(settled.status, 'failed');
    assert.deepEqual(settled.error, {
      code: 'E_VIDEO_UNAVAILABLE',
      message: 'This video is a live stream. Try again once it has ended.',
    });
  });

  it('reports a video over the size limit as too large, on the job and on its download', async () => {
    setMode('too-large');
    const settled = await runJob('mp4', CANONICAL);
    assert.equal(settled.status, 'failed');
    assert.equal((settled.error as { code: string }).code, 'E_TOO_LARGE');

    const download = await downloadMediaJob(server.baseUrl, settled.id as string);
    assert.equal(download.status, 413);
  });

  it('reports a download that produced no file, and no reason it recognises, as a generic failure', async () => {
    setMode('nothing');
    const settled = await runJob('mp4', CANONICAL);
    assert.equal(settled.status, 'failed');
    assert.deepEqual(settled.error, {
      code: 'E_CONVERT_FAILED',
      message: 'This video could not be downloaded. Try again in a few minutes.',
    });
  });

  it('reports a yt-dlp crash as a generic failure, without yt-dlp\'s own text in the message', async () => {
    setMode('fail');
    const settled = await runJob('mp4', CANONICAL);
    assert.equal(settled.status, 'failed');
    assert.equal((settled.error as { code: string }).code, 'E_CONVERT_FAILED');
    assert.ok(!JSON.stringify(settled.error).includes('connection reset'));
  });

  it('shares the media job status endpoint, so a YouTube job reports like an upload job', async () => {
    setMode('ok');
    const settled = await runJob('mp3', CANONICAL);
    const response = await fetch(`${server.baseUrl}/media/jobs/${settled.id as string}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, 'done');
    assert.equal(body.target, 'mp3');
    assert.equal(body.downloadUrl, `/media/jobs/${settled.id as string}/download`);
  });
});

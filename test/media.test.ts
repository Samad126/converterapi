/**
 * `POST /media/{target}` - the async audio/video job endpoint (Phase 5).
 *
 * Real ffmpeg, real files, and the real job lifecycle end to end: accept,
 * poll, download. `buildMediaFixture` synthesises its own audio/video with
 * ffmpeg's own `lavfi` test sources, so nothing here depends on a checked-in
 * binary fixture.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMediaFixture,
  downloadMediaJob,
  getMediaJobStatus,
  pollMediaJob,
  startTestServer,
  uploadMedia,
  type TestServer,
} from './helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe('POST /media/{target} - audio', () => {
  it('accepts a real WAV and converts it to a real MP3, end to end', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'mp3');
    assert.equal(status, 202);
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.id, 'string');
    assert.equal(body.statusUrl, `/media/jobs/${body.id as string}`);

    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    assert.equal(finished.downloadUrl, `/media/jobs/${body.id as string}/download`);

    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/mpeg');
    // A real MP3: either an ID3v2 tag or a raw frame sync word up front.
    const head = download.body.subarray(0, 3).toString('latin1');
    assert.ok(head === 'ID3' || download.body[0] === 0xff, 'not a real MP3');
  });

  it('converts WAV to FLAC', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'flac');
    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.contentType, 'audio/flac');
    assert.equal(download.body.subarray(0, 4).toString('ascii'), 'fLaC');
  });

  it('converts WAV to OPUS', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'opus');
    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/opus');
    assert.equal(download.body.subarray(0, 4).toString('ascii'), 'OggS');
  });

  it('converts WAV to AIFF', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'aiff');
    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/aiff');
    assert.equal(download.body.subarray(0, 4).toString('ascii'), 'FORM');
  });

  it('converts WAV to M4B', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'm4b');
    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'audio/mp4');
    // An MP4-family container: 'ftyp' box tag sits at byte offset 4.
    assert.equal(download.body.subarray(4, 8).toString('ascii'), 'ftyp');
  });
});

describe('POST /media/{target} - video', () => {
  it('accepts a real MP4 and converts it to a real WEBM, end to end', async () => {
    const mp4 = await buildMediaFixture('video', 'mp4');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.mp4', mp4, 'webm');
    assert.equal(status, 202);

    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');

    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'video/webm');
    // EBML magic, which every Matroska/WebM file starts with.
    assert.equal(download.body.subarray(0, 4).toString('hex'), '1a45dfa3');
  });

  it('converts MP4 to MKV', async () => {
    const mp4 = await buildMediaFixture('video', 'mp4');
    const { body } = await uploadMedia(server.baseUrl, 'clip.mp4', mp4, 'mkv');
    const finished = await pollMediaJob(server.baseUrl, body.id as string);
    assert.equal(finished.status, 'done');
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    assert.equal(download.contentType, 'video/x-matroska');
  });
});

describe('POST /media/{target} - validation', () => {
  it('rejects an unsupported extension with 415', async () => {
    const { status, body } = await uploadMedia(
      server.baseUrl,
      'document.docx',
      Buffer.from('not audio'),
      'mp3',
    );
    assert.equal(status, 415);
    assert.equal((body.error as { code: string }).code, 'E_UNSUPPORTED');
  });

  it('rejects an unknown target with 404', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'banana');
    assert.equal(status, 404);
    assert.equal((body.error as { code: string }).code, 'E_UNKNOWN_TARGET');
  });

  it('refuses an audio source asking for a video target', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'mp4');
    assert.equal(status, 415);
    const error = body.error as { code: string; message: string };
    assert.equal(error.code, 'E_UNSUPPORTED_TARGET');
    assert.match(error.message, /MP3|WAV|FLAC/);
  });

  it('refuses a video source asking for an audio target', async () => {
    const mp4 = await buildMediaFixture('video', 'mp4');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.mp4', mp4, 'mp3');
    assert.equal(status, 415);
    assert.equal((body.error as { code: string }).code, 'E_UNSUPPORTED_TARGET');
  });

  it('refuses a source converting to its own format', async () => {
    const wav = await buildMediaFixture('audio', 'wav');
    const { status, body } = await uploadMedia(server.baseUrl, 'clip.wav', wav, 'wav');
    assert.equal(status, 415);
    assert.equal((body.error as { code: string }).code, 'E_UNSUPPORTED_TARGET');
  });

  it('returns 404 for a job id that does not exist', async () => {
    const { status, body } = await getMediaJobStatus(server.baseUrl, 'not-a-real-job-id');
    assert.equal(status, 404);
    assert.equal((body.error as { code: string }).code, 'E_JOB_NOT_FOUND');
  });

  it('returns 404 for a download of a job id that does not exist', async () => {
    const download = await downloadMediaJob(server.baseUrl, 'not-a-real-job-id');
    assert.equal(download.status, 404);
  });

  it('answers 409 for a download requested before the job is ready', async () => {
    const mp4 = await buildMediaFixture('video', 'mp4');
    const { body } = await uploadMedia(server.baseUrl, 'clip.mp4', mp4, 'mkv');
    // Ask immediately - the job has not had time to finish yet.
    const download = await downloadMediaJob(server.baseUrl, body.id as string);
    if (download.status === 200) {
      // Rare but legitimate: this machine finished the transcode before the
      // very next request landed. Not a failure of the behaviour under test.
      return;
    }
    assert.equal(download.status, 409);
    // Drain the job so its background work does not outlive the test file.
    await pollMediaJob(server.baseUrl, body.id as string);
  });
});

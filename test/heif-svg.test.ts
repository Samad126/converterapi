/**
 * End-to-end checks for the `svg`/`heic`/`heif` targets added to the matrix -
 * real HTTP requests against a real server, exercising real `soffice`/
 * `ffmpeg`/`heif-convert`/`heif-enc` subprocesses, not just `resolveConversion`.
 *
 * Fixtures are built by shelling out to the very tools the pipeline itself
 * uses (`ffmpeg`, `heif-enc`) rather than a hand-rolled byte builder like
 * `fixtures.ts` uses elsewhere: there is no reasonable way to author a valid
 * HEIC container by hand, and a real one is what every other fixture in this
 * suite insists on (`.no-rar` in `formats.ts`'s own comments states the same
 * rule). This does mean a bug shared between the fixture step and the
 * pipeline step could hide from these tests - what it verifies is the
 * ROUTING and subprocess WIRING (`resolveConversion`'s `heif`-engine
 * branches, the intermediate-PNG hops in `runHeifPipeline`), not `libheif`'s
 * own encoder correctness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startTestServer, upload } from './helpers.ts';

const run = promisify(execFile);

test('svg/heic/heif real conversions', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const dir = await fsp.mkdtemp(join(tmpdir(), 'smoke-'));
  const svgPath = join(dir, 't.svg');
  await fsp.writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="blue"/></svg>',
  );
  const pngPath = join(dir, 't.png');
  await run('ffmpeg', ['-y', '-i', svgPath, '-frames:v', '1', '-update', '1', pngPath]);
  const heicPath = join(dir, 't.heic');
  await run('heif-enc', ['-o', heicPath, pngPath]);

  const svgBytes = await fsp.readFile(svgPath);
  const pngBytes = await fsp.readFile(pngPath);
  const heicBytes = await fsp.readFile(heicPath);

  await t.test('svg -> png', async () => {
    const res = await upload(server.baseUrl, 't.svg', svgBytes, { target: 'png-image' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.equal(res.contentType, 'image/png');
  });

  await t.test('svg -> pdf', async () => {
    const res = await upload(server.baseUrl, 't.svg', svgBytes, { target: 'pdf' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
  });

  await t.test('png -> svg', async () => {
    const res = await upload(server.baseUrl, 't.png', pngBytes, { target: 'svg' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.equal(res.contentType, 'image/svg+xml');
  });

  await t.test('png -> heic', async () => {
    const res = await upload(server.baseUrl, 't.png', pngBytes, { target: 'heic' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.equal(res.contentType, 'image/heic');
  });

  await t.test('heic -> png-image', async () => {
    const res = await upload(server.baseUrl, 't.heic', heicBytes, { target: 'png-image' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
  });

  await t.test('heic -> bmp (intermediate-PNG path)', async () => {
    const res = await upload(server.baseUrl, 't.heic', heicBytes, { target: 'bmp' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.equal(res.contentType, 'image/bmp');
  });

  await t.test('heic -> heif', async () => {
    const res = await upload(server.baseUrl, 't.heic', heicBytes, { target: 'heif' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.equal(res.contentType, 'image/heif');
  });

  await t.test('bmp -> heic (pre-transcode path)', async () => {
    const bmpPath = join(dir, 't.bmp');
    await run('ffmpeg', ['-y', '-i', pngPath, bmpPath]);
    const bmpBytes = await fsp.readFile(bmpPath);
    const res = await upload(server.baseUrl, 't.bmp', bmpBytes, { target: 'heic' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
  });
});

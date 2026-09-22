/**
 * End-to-end checks for the second wave of formats added to the matrix:
 * `.emf`/`.wmf`/`.eps` (vector, via LibreOffice Draw), `.jxl`/`.jp2`/`.qoi`/
 * `.tga`/`.pcx`/`.apng` (raster, via `ffmpeg`), `.xml`/`.toml`/`.ini`/
 * `.sqlite` (data, via `data.service.ts`), and `.zst`/`tar.zst` (archive,
 * via the standalone `zstd` CLI). Real HTTP requests against a real server,
 * real subprocesses - see `heif-svg.test.ts`'s own header comment for why
 * fixtures are built by shelling out rather than hand-rolled.
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

test('vector/raster/data/archive second-wave formats', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const dir = await fsp.mkdtemp(join(tmpdir(), 'wave2-'));
  const svgPath = join(dir, 't.svg');
  await fsp.writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="green"/></svg>',
  );
  const pngPath = join(dir, 't.png');
  await run('ffmpeg', ['-y', '-i', svgPath, '-frames:v', '1', '-update', '1', pngPath]);
  const pngBytes = await fsp.readFile(pngPath);

  // --- vector: emf/wmf/eps via Draw --------------------------------------
  await t.test('png -> emf', async () => {
    const res = await upload(server.baseUrl, 't.png', pngBytes, { target: 'emf' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
  });

  await t.test('png -> eps -> pdf round trip', async () => {
    const epsRes = await upload(server.baseUrl, 't.png', pngBytes, { target: 'eps' });
    assert.equal(epsRes.status, 200, epsRes.body.toString('utf8').slice(0, 300));
    const pdfRes = await upload(server.baseUrl, 't.eps', epsRes.body, { target: 'pdf' });
    assert.equal(pdfRes.status, 200, pdfRes.body.toString('utf8').slice(0, 300));
  });

  await t.test('wmf -> svg', async () => {
    // Not `png-image`: `.wmf` has no `ffmpeg` decoder in this build, so it
    // never gains `TRANSCODE_TARGETS` the way `.svg`/`.png`/`.jpg` do - its
    // only single-image routes are the Draw ones (`pdf`/`svg`/`emf`/`eps`).
    const wmfRes = await upload(server.baseUrl, 't.png', pngBytes, { target: 'wmf' });
    assert.equal(wmfRes.status, 200);
    const svgRes = await upload(server.baseUrl, 't.wmf', wmfRes.body, { target: 'svg' });
    assert.equal(svgRes.status, 200, svgRes.body.toString('utf8').slice(0, 300));
    assert.equal(svgRes.contentType, 'image/svg+xml');
  });

  // --- raster: jxl/jp2/qoi/tga/pcx/apng via ffmpeg -----------------------
  for (const target of ['jxl', 'jp2', 'qoi', 'tga', 'pcx', 'apng']) {
    await t.test(`png -> ${target} -> png-image round trip`, async () => {
      const res = await upload(server.baseUrl, 't.png', pngBytes, { target });
      assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
      const back = await upload(server.baseUrl, `t.${target}`, res.body, { target: 'png-image' });
      assert.equal(back.status, 200, back.body.toString('utf8').slice(0, 300));
    });
  }

  // --- data: xml/toml/ini/sqlite -----------------------------------------
  await t.test('json -> xml -> json round trip', async () => {
    const json = Buffer.from(JSON.stringify({ root: { item: { _text: 'hello' } } }));
    const xmlRes = await upload(server.baseUrl, 't.json', json, { target: 'xml' });
    assert.equal(xmlRes.status, 200, xmlRes.body.toString('utf8').slice(0, 300));
    assert.match(xmlRes.body.toString('utf8'), /<root>/);
    const backRes = await upload(server.baseUrl, 't.xml', xmlRes.body, { target: 'json' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
  });

  await t.test('yaml -> toml', async () => {
    const yaml = Buffer.from('title: hi\nowner:\n  name: tom\n');
    const res = await upload(server.baseUrl, 't.yaml', yaml, { target: 'toml' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.match(res.body.toString('utf8'), /title = "hi"/);
  });

  await t.test('json -> ini', async () => {
    const json = Buffer.from(JSON.stringify({ section: { key: 'value' } }));
    const res = await upload(server.baseUrl, 't.json', json, { target: 'ini' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    assert.match(res.body.toString('utf8'), /\[section]/);
  });

  await t.test('csv -> sqlite -> csv round trip', async () => {
    const csv = Buffer.from('a,b\n1,2\n3,4\n');
    const sqliteRes = await upload(server.baseUrl, 't.csv', csv, { target: 'sqlite' });
    assert.equal(sqliteRes.status, 200, sqliteRes.body.toString('utf8').slice(0, 300));
    assert.equal(sqliteRes.contentType, 'application/vnd.sqlite3');
    const backRes = await upload(server.baseUrl, 't.sqlite', sqliteRes.body, { target: 'csv' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
    assert.match(backRes.body.toString('utf8'), /a,b/);
    assert.match(backRes.body.toString('utf8'), /1,2/);
  });

  // --- archive: .zst / tar.zst via the standalone zstd CLI ---------------
  await t.test('zip -> tar.zst -> zip round trip', async () => {
    const zipEntryPath = join(dir, 'inner.txt');
    await fsp.writeFile(zipEntryPath, 'hello from zst');
    const zipPath = join(dir, 't.zip');
    await run('7z', ['a', '-tzip', zipPath, zipEntryPath]);
    const zipBytes = await fsp.readFile(zipPath);

    const zstRes = await upload(server.baseUrl, 't.zip', zipBytes, { target: 'tar.zst' });
    assert.equal(zstRes.status, 200, zstRes.body.toString('utf8').slice(0, 300));
    assert.equal(zstRes.contentType, 'application/zstd');

    const backRes = await upload(server.baseUrl, 't.tar.zst', zstRes.body, { target: 'zip' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
  });

  await t.test('.zst (bare tar) reads back as a real archive source', async () => {
    const tarPath = join(dir, 't2.tar');
    const fileInTar = join(dir, 'file.txt');
    await fsp.writeFile(fileInTar, 'zst source test');
    await run('tar', ['cf', tarPath, '-C', dir, 'file.txt']);
    const zstPath = join(dir, 't2.tar.zst');
    await run('zstd', ['-f', '-o', zstPath, tarPath]);
    const zstBytes = await fsp.readFile(zstPath);

    const res = await upload(server.baseUrl, 't2.zst', zstBytes, { target: 'zip' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
  });
});

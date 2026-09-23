/**
 * End-to-end checks for the third wave of formats added to the matrix:
 * `.obj`/`.stl`/`.ply`/`.glb`/`.3mf`/`.off` (3D, via `assimp`) and
 * `.epub`/`.mobi`/`.azw3`/`.fb2`/`.lrf`/`.pdb`/`.snb`/KEPUB (ebook, via
 * Calibre's `ebook-convert`). Real HTTP requests against a real server, real
 * subprocesses - see `heif-svg.test.ts`'s own header comment for why
 * fixtures are built by shelling out rather than hand-rolled.
 *
 * Neither `assimp` nor `ebook-convert` is on the development machine's own
 * PATH, unlike every other tool this service's other test files exercise -
 * this suite auto-skips (rather than failing) when either is missing, so
 * `npm test` stays clean on a machine that has not installed them, and runs
 * for real wherever both are present (verified by hand inside
 * `docker run --rm -v $PWD:/app -w /app node:22-bookworm-slim` with
 * `calibre`/`assimp-utils` installed, exactly as `Dockerfile` installs them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startTestServer, upload } from '../../support/helpers.ts';

const run = promisify(execFile);

async function commandSucceeds(bin: string, args: string[]): Promise<boolean> {
  try {
    await run(bin, args);
    return true;
  } catch {
    return false;
  }
}

test('3d/ebook third-wave formats', async (t) => {
  const [hasAssimp, hasEbookConvert] = await Promise.all([
    commandSucceeds('assimp', ['version']),
    commandSucceeds('ebook-convert', ['--version']),
  ]);
  if (!hasAssimp || !hasEbookConvert) {
    t.skip(
      `assimp (${hasAssimp ? 'found' : 'missing'}) / ebook-convert (${hasEbookConvert ? 'found' : 'missing'}) ` +
        'not on PATH - see this file\'s own header comment for how to run it for real.',
    );
    return;
  }

  const server = await startTestServer();
  t.after(() => server.close());

  const dir = await fsp.mkdtemp(join(tmpdir(), 'wave3-'));

  // --- 3D: obj/stl/ply/glb/3mf/off via assimp -----------------------------
  await t.test('obj -> stl -> glb -> ply -> 3mf -> obj round trip', async () => {
    const objBytes = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const stlRes = await upload(server.baseUrl, 't.obj', objBytes, { target: 'stl' });
    assert.equal(stlRes.status, 200, stlRes.body.toString('utf8').slice(0, 300));

    const glbRes = await upload(server.baseUrl, 't.stl', stlRes.body, { target: 'glb' });
    assert.equal(glbRes.status, 200, glbRes.body.toString('utf8').slice(0, 300));

    const plyRes = await upload(server.baseUrl, 't.glb', glbRes.body, { target: 'ply' });
    assert.equal(plyRes.status, 200, plyRes.body.toString('utf8').slice(0, 300));

    const mfRes = await upload(server.baseUrl, 't.ply', plyRes.body, { target: '3mf' });
    assert.equal(mfRes.status, 200, mfRes.body.toString('utf8').slice(0, 300));

    const backRes = await upload(server.baseUrl, 't.3mf', mfRes.body, { target: 'obj' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
    assert.equal(backRes.contentType, 'model/obj');
  });

  await t.test('.off reads but cannot be written', async () => {
    const offBytes = Buffer.from('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n');
    const objRes = await upload(server.baseUrl, 't.off', offBytes, { target: 'obj' });
    assert.equal(objRes.status, 200, objRes.body.toString('utf8').slice(0, 300));

    const offTargetRes = await upload(server.baseUrl, 't.obj', objRes.body, { target: 'off' as never });
    assert.equal(offTargetRes.status, 404, 'off should not exist as a writable target');
  });

  // --- ebook: epub/mobi/azw3/fb2/lrf/pdb/snb/kepub via Calibre -----------
  const txtPath = join(dir, 't.txt');
  await fsp.writeFile(txtPath, 'Chapter 1\n\nHello world, this is a real ebook fixture.\n');
  const epubPath = join(dir, 't.epub');
  await run('ebook-convert', [txtPath, epubPath, '--title', 'Test Book', '--authors', 'Test Author']);
  const epubBytes = await fsp.readFile(epubPath);

  await t.test('epub -> mobi -> azw3 -> fb2 -> lrf -> pdb round trip', async () => {
    const mobiRes = await upload(server.baseUrl, 't.epub', epubBytes, { target: 'mobi' });
    assert.equal(mobiRes.status, 200, mobiRes.body.toString('utf8').slice(0, 300));

    const azw3Res = await upload(server.baseUrl, 't.mobi', mobiRes.body, { target: 'azw3' });
    assert.equal(azw3Res.status, 200, azw3Res.body.toString('utf8').slice(0, 300));

    const fb2Res = await upload(server.baseUrl, 't.azw3', azw3Res.body, { target: 'fb2' });
    assert.equal(fb2Res.status, 200, fb2Res.body.toString('utf8').slice(0, 300));

    const lrfRes = await upload(server.baseUrl, 't.fb2', fb2Res.body, { target: 'lrf' });
    assert.equal(lrfRes.status, 200, lrfRes.body.toString('utf8').slice(0, 300));

    const pdbRes = await upload(server.baseUrl, 't.lrf', lrfRes.body, { target: 'pdb' });
    assert.equal(pdbRes.status, 200, pdbRes.body.toString('utf8').slice(0, 300));

    const backEpubRes = await upload(server.baseUrl, 't.pdb', pdbRes.body, { target: 'epub' });
    assert.equal(backEpubRes.status, 200, backEpubRes.body.toString('utf8').slice(0, 300));
  });

  await t.test('epub -> kepub (double extension) -> epub reads back', async () => {
    const kepubRes = await upload(server.baseUrl, 't.epub', epubBytes, { target: 'kepub' });
    assert.equal(kepubRes.status, 200, kepubRes.body.toString('utf8').slice(0, 300));
    assert.match(kepubRes.contentDisposition ?? '', /filename=".*\.kepub\.epub"/);

    const backRes = await upload(server.baseUrl, 't.kepub.epub', kepubRes.body, { target: 'mobi' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
  });

  await t.test('epub -> snb writes, but .snb cannot be read back', async () => {
    const snbRes = await upload(server.baseUrl, 't.epub', epubBytes, { target: 'snb' });
    assert.equal(snbRes.status, 200, snbRes.body.toString('utf8').slice(0, 300));

    const backRes = await upload(server.baseUrl, 't.snb', snbRes.body, { target: 'epub' });
    assert.equal(backRes.status, 415, '.snb should not exist as a readable source');
  });
});

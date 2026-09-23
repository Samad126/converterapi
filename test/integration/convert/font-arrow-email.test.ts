/**
 * End-to-end checks for the fourth wave of formats added to the matrix:
 * `.ttf`/`.otf`/`.woff`/`.woff2` (fonts, via `fontTools`), `.parquet`/
 * `.orc`/`.feather` (columnar data, via `pyarrow`), and `.eml` (via
 * `mailparser`, reaching the existing `txt`/`html` targets). Real HTTP
 * requests against a real server, real subprocesses - see
 * `heif-svg.test.ts`'s own header comment for why fixtures are built by
 * shelling out rather than hand-rolled.
 *
 * `pyarrow` is not on the development machine's own PATH, unlike
 * `fontTools`/`mailparser` - the `.parquet`/`.orc`/`.feather` subtest
 * auto-skips when it is missing, the same pattern `ebook-3d.test.ts` uses
 * for `assimp`/`ebook-convert` (verified by hand inside
 * `docker run --rm -v $PWD:/app -w /app node:22-bookworm-slim` with the
 * Dockerfile's own `pip install pyarrow` run first).
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

test('font/arrow/email fourth-wave formats', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const dir = await fsp.mkdtemp(join(tmpdir(), 'wave4-'));

  // --- fonts: ttf/otf/woff/woff2 via fontTools ----------------------------
  await t.test('ttf -> otf -> woff -> woff2 -> ttf round trip', async (t2) => {
    // `runProcess` (soffice.engine.ts) deliberately overrides `HOME` to the
    // request's own workspace for every subprocess it spawns, so a `pip
    // install --user` fontTools (findable from an ordinary shell, but only
    // via `$HOME/.local`) silently is NOT findable through the real
    // pipeline - verified by hand, the exact gap that made this subtest
    // fail locally before this check existed. Production installs
    // `python3-fonttools` system-wide via apt (see the Dockerfile), which
    // has no such dependency on `$HOME` - this check simulates that same
    // restriction rather than a plain "is fontTools on PATH at all" one,
    // so it reports "will this really work through the pipeline", not just
    // "is it importable from this shell".
    const probe = await run('python3', ['-c', 'import fontTools'], { env: { ...process.env, HOME: dir } }).then(
      () => true,
      () => false,
    );
    if (!probe) {
      t2.skip(
        'fontTools not importable with HOME overridden (production installs it system-wide via apt, ' +
          'unaffected - see this subtest\'s own comment)',
      );
      return;
    }

    const ttfBytes = await fsp.readFile(join(import.meta.dirname, '..', '..', '..', 'assets', 'fonts', 'DancingScript.ttf'));

    const otfRes = await upload(server.baseUrl, 't.ttf', ttfBytes, { target: 'otf' });
    assert.equal(otfRes.status, 200, otfRes.body.toString('utf8').slice(0, 300));

    const woffRes = await upload(server.baseUrl, 't.otf', otfRes.body, { target: 'woff' });
    assert.equal(woffRes.status, 200, woffRes.body.toString('utf8').slice(0, 300));

    const woff2Res = await upload(server.baseUrl, 't.woff', woffRes.body, { target: 'woff2' });
    assert.equal(woff2Res.status, 200, woff2Res.body.toString('utf8').slice(0, 300));
    assert.equal(woff2Res.contentType, 'font/woff2');

    const backRes = await upload(server.baseUrl, 't.woff2', woff2Res.body, { target: 'ttf' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
  });

  // --- data: parquet/orc/feather via pyarrow (auto-skips if missing) -----
  await t.test('csv -> parquet -> orc -> feather -> csv round trip', async (t2) => {
    if (!(await commandSucceeds('python3', ['-c', 'import pyarrow']))) {
      t2.skip('pyarrow not on PATH - see this file\'s own header comment for how to run it for real');
      return;
    }

    const csv = Buffer.from('a,b\n1,2\n3,4\n');
    const parquetRes = await upload(server.baseUrl, 't.csv', csv, { target: 'parquet' });
    assert.equal(parquetRes.status, 200, parquetRes.body.toString('utf8').slice(0, 300));
    assert.equal(parquetRes.contentType, 'application/vnd.apache.parquet');

    const orcRes = await upload(server.baseUrl, 't.parquet', parquetRes.body, { target: 'orc' });
    assert.equal(orcRes.status, 200, orcRes.body.toString('utf8').slice(0, 300));

    const featherRes = await upload(server.baseUrl, 't.orc', orcRes.body, { target: 'feather' });
    assert.equal(featherRes.status, 200, featherRes.body.toString('utf8').slice(0, 300));

    const backRes = await upload(server.baseUrl, 't.feather', featherRes.body, { target: 'csv' });
    assert.equal(backRes.status, 200, backRes.body.toString('utf8').slice(0, 300));
    assert.match(backRes.body.toString('utf8'), /a,b/);
    assert.match(backRes.body.toString('utf8'), /1,2/);
  });

  // --- email: .eml -> txt/html via mailparser -----------------------------
  const emlPath = join(dir, 't.eml');
  await fsp.writeFile(
    emlPath,
    [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Real test email',
      'Date: Mon, 1 Jan 2024 12:00:00 +0000',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hello <b>Bob</b>, this is a real fixture.</p>',
    ].join('\r\n'),
  );
  const emlBytes = await fsp.readFile(emlPath);

  await t.test('eml -> txt', async () => {
    const res = await upload(server.baseUrl, 't.eml', emlBytes, { target: 'txt' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    const text = res.body.toString('utf8');
    assert.match(text, /Subject: Real test email/);
    assert.match(text, /Hello Bob/);
  });

  await t.test('eml -> html', async () => {
    const res = await upload(server.baseUrl, 't.eml', emlBytes, { target: 'html' });
    assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 300));
    const html = res.body.toString('utf8');
    assert.match(html, /Subject: Real test email/);
    assert.match(html, /<p>Hello <b>Bob<\/b>/);
  });

  await t.test('.msg has no legal fixture, so it is not in the matrix at all', async () => {
    const res = await upload(server.baseUrl, 't.msg', Buffer.from('not a real msg'), { target: 'txt' });
    assert.equal(res.status, 415);
  });
});

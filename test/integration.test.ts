/**
 * End-to-end tests against the real HTTP surface, converting real documents
 * with the real soffice.
 *
 * These assert the wire contract the shipped Android client depends on: a
 * success is application/pdf, a failure is a non-2xx carrying the JSON
 * envelope, and a failure is never a 200.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  expectJsonEnvelope,
  listWorkspaces,
  startTestServer,
  upload,
  waitFor,
  type TestServer,
} from './helpers.ts';
import {
  buildEncryptedDocxContainer,
  buildEncryptedLegacyDoc,
  buildMalformedDocx,
} from './fixtures.ts';

const execFileAsync = promisify(execFile);

const { buildMinimalDocx } = await import('../src/convert.ts');
const { MAX_UPLOAD_BYTES } = await import('../src/config.ts');

/** A small but genuine .docx, built from real OOXML parts. */
const SAMPLE_DOCX = buildMinimalDocx([
  'Pagination fidelity check',
  'Calibri and Cambria metrics determine where every line breaks.',
  'The quick brown fox jumps over the lazy dog, repeatedly, to fill a line.',
]);

/**
 * Big enough that a conversion takes long enough to interrupt.
 * Measured: ~850ms of soffice startup plus ~0.4ms per paragraph, so this is
 * roughly 2.5s - comfortably longer than the time it takes to notice soffice
 * running and walk away.
 */
const LARGE_DOCX = buildMinimalDocx(
  Array.from(
    { length: 8000 },
    (_, i) =>
      `Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again, filling the line so pagination is observable across many pages.`,
  ),
);

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe('GET /health', () => {
  it('reports ok once soffice has been confirmed', async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

describe('POST /convert - success', () => {
  it('converts a real .docx and returns PDF bytes', async () => {
    const response = await upload(server.baseUrl, 'sample.docx', SAMPLE_DOCX);

    assert.equal(response.status, 200);
    // Constraint 1: the client checks this header and refuses anything else.
    assert.equal(response.contentType, 'application/pdf');
    assert.equal(response.body.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(response.body.length > 1000, 'PDF looks implausibly small');
  });

  it('accepts .docm', async () => {
    const response = await upload(server.baseUrl, 'sample.docm', SAMPLE_DOCX);
    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    assert.equal(response.body.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('accepts a .doc extension', async () => {
    // LibreOffice sniffs content, so OOXML written under a .doc name still
    // converts - the point here is that the extension is allowed through the
    // filter rather than rejected with 415.
    const response = await upload(server.baseUrl, 'sample.doc', SAMPLE_DOCX);
    assert.notEqual(response.status, 415);
  });

  it('picks the import filter from the filename, not the declared MIME type', async () => {
    // The client deliberately sends application/octet-stream; a hostile client
    // could send anything at all. The extension is the only thing we act on.
    const response = await upload(server.baseUrl, 'sample.docx', SAMPLE_DOCX, {
      mimeType: 'image/png',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('ignores a path-traversal filename and keeps the upload inside its workspace', async () => {
    const response = await upload(server.baseUrl, '../../../../tmp/evil.docx', SAMPLE_DOCX);
    assert.equal(response.status, 200);
    // Nothing was written outside the temp root: the name on disk is ours.
    assert.equal(await fsp.readdir('/tmp').then((e) => e.includes('evil.docx')), false);
  });

  it('deletes the workspace before answering', async () => {
    const before_ = await listWorkspaces();
    const response = await upload(server.baseUrl, 'cleanup.docx', SAMPLE_DOCX);
    assert.equal(response.status, 200);
    // Cleanup happens before the response is written, so there is no race here.
    assert.deepEqual(await listWorkspaces(), before_);
  });
});

describe('POST /convert - rejections', () => {
  it('rejects an oversized upload with 413', async () => {
    const response = await upload(
      server.baseUrl,
      'big.docx',
      Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41),
    );
    // multer's default here would be an HTML error page; the client needs JSON.
    const error = expectJsonEnvelope(response, 413, 'E_TOO_LARGE');
    assert.equal(error.message, 'This document is too large to convert.');
  });

  it('rejects an unsupported extension with 415', async () => {
    const response = await upload(server.baseUrl, 'photo.png', SAMPLE_DOCX);
    const error = expectJsonEnvelope(response, 415, 'E_UNSUPPORTED');
    assert.equal(error.message, 'Only Word documents (.docx, .docm, .doc) can be converted.');
  });

  it('rejects a file with no extension with 415', async () => {
    const response = await upload(server.baseUrl, 'document', SAMPLE_DOCX);
    expectJsonEnvelope(response, 415, 'E_UNSUPPORTED');
  });

  it('rejects a malformed document with 500', async () => {
    const response = await upload(server.baseUrl, 'broken.docx', buildMalformedDocx());
    const error = expectJsonEnvelope(response, 500, 'E_CONVERT_FAILED');
    assert.equal(
      error.message,
      'This document could not be converted. It may be damaged or in a format the converter does not support.',
    );
  });

  it('rejects an empty upload rather than returning a blank PDF', async () => {
    // LibreOffice happily opens a zero-byte file as an empty document and
    // exports a valid blank PDF, which would be a 200 carrying a document the
    // user never had.
    const response = await upload(server.baseUrl, 'empty.docx', Buffer.alloc(0));
    expectJsonEnvelope(response, 500, 'E_CONVERT_FAILED');
  });

  it('rejects an encrypted .docx with 422', async () => {
    const response = await upload(server.baseUrl, 'secret.docx', buildEncryptedDocxContainer());
    const error = expectJsonEnvelope(response, 422, 'E_ENCRYPTED');
    assert.equal(error.message, 'This document is password protected.');
  });

  it('rejects an encrypted legacy .doc with 422', async () => {
    const response = await upload(server.baseUrl, 'secret.doc', buildEncryptedLegacyDoc());
    expectJsonEnvelope(response, 422, 'E_ENCRYPTED');
  });

  it('rejects a request with no file part with 400', async () => {
    const response = await upload(server.baseUrl, 'sample.docx', SAMPLE_DOCX, {
      fieldName: 'document',
    });
    expectJsonEnvelope(response, 400, 'E_BAD_REQUEST');
  });

  it('never returns a failure as a 200', async () => {
    const failures = [
      await upload(server.baseUrl, 'photo.png', SAMPLE_DOCX),
      await upload(server.baseUrl, 'broken.docx', buildMalformedDocx()),
      await upload(server.baseUrl, 'empty.docx', Buffer.alloc(0)),
      await upload(server.baseUrl, 'secret.docx', buildEncryptedDocxContainer()),
    ];
    for (const response of failures) {
      assert.notEqual(response.status, 200);
      assert.ok(response.status >= 400 && response.status < 600);
      assert.match(response.contentType ?? '', /application\/json/);
    }
  });

  it('deletes the workspace after a failed conversion', async () => {
    const before_ = await listWorkspaces();
    await upload(server.baseUrl, 'broken.docx', buildMalformedDocx());
    assert.deepEqual(await listWorkspaces(), before_);
  });
});

describe('cancellation', () => {
  it('kills the running soffice when the client disconnects', async () => {
    const controller = new AbortController();
    const form = new FormData();
    form.append('file', new Blob([LARGE_DOCX]), 'large.docx');

    const request = fetch(`${server.baseUrl}/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    }).catch(() => undefined); // The abort rejects this; that is the point.

    // Wait for soffice to actually be running, so this test cannot pass
    // vacuously by aborting before any work started.
    const started = await waitFor(async () => (await sofficeForWorkspaces()).length > 0, 30_000);
    assert.ok(started, 'soffice never started; the fixture may be too small to interrupt');

    const abortedAt = Date.now();
    controller.abort();
    await request;

    // The workspace goes away...
    const cleaned = await waitFor(async () => (await listWorkspaces()).length === 0, 20_000);
    assert.ok(cleaned, 'workspace was not cleaned up after the client disconnected');

    // ...and so does the process, rather than burning CPU until the timeout.
    const killed = await waitFor(async () => (await sofficeForWorkspaces()).length === 0, 20_000);
    assert.ok(killed, `soffice still running: ${(await sofficeForWorkspaces()).join(' | ')}`);

    // Proving it was killed rather than merely finishing: an 8000-paragraph
    // document needs ~2.5s, and we walked away about 100ms in. If this were
    // natural completion it could not possibly be this quick.
    const killedAfterMs = Date.now() - abortedAt;
    assert.ok(
      killedAfterMs < 1500,
      `soffice took ${killedAfterMs}ms to disappear after the abort - it looks like it ran to completion instead of being killed`,
    );
  });
});

async function sofficeForWorkspaces(): Promise<string[]> {
  const { TEMP_ROOT } = await import('./helpers.ts');
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'args'], { maxBuffer: 8 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((line) => line.includes(TEMP_ROOT) && line.includes('soffice'))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

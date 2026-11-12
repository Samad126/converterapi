/**
 * `POST /convert/{target}/jobs` - the same conversion as `/convert/{target}`,
 * answered `202` and run in the background so no single request has to outlast
 * a proxy's idle timeout.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPptxFixture, startTestServer, type TestServer } from '../../support/helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function startJob(filename: string, bytes: Buffer, target = 'pdf') {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(bytes)]), filename);
  const response = await fetch(`${server.baseUrl}/convert/${target}/jobs`, { method: 'POST', body: form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitForJob(id: string): Promise<Record<string, unknown>> {
  let status = 'running';
  for (let i = 0; i < 40; i += 1) {
    const response = await fetch(`${server.baseUrl}/convert/jobs/${id}?wait=5&status=${status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === 'done' || body.status === 'failed') return body;
    status = String(body.status);
  }
  throw new Error('job never finished');
}

describe('POST /convert/{target}/jobs', () => {
  it('accepts with 202, then serves the real PDF from the download URL', async () => {
    const pptx = await buildPptxFixture(['Hello job']);
    const started = await startJob('deck.pptx', pptx);
    assert.equal(started.status, 202);
    assert.equal(started.body.statusUrl, `/convert/jobs/${started.body.id as string}`);

    const finished = await waitForJob(started.body.id as string);
    assert.equal(finished.status, 'done');

    const download = await fetch(`${server.baseUrl}${finished.downloadUrl as string}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition') ?? '', /deck\.pdf/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('refuses a bad request before accepting it, exactly like the synchronous endpoint', async () => {
    const unknown = await startJob('deck.pptx', Buffer.from('x'), 'nope');
    assert.equal(unknown.status, 404);
    const empty = await fetch(`${server.baseUrl}/convert/pdf/jobs`, { method: 'POST', body: new FormData() });
    assert.equal(empty.status, 400);
  });

  it('reports a conversion failure on the job, not as a lost request', async () => {
    const started = await startJob('empty.docx', Buffer.alloc(0));
    assert.equal(started.status, 202);
    const finished = await waitForJob(started.body.id as string);
    assert.equal(finished.status, 'failed');
    assert.ok(finished.error);
    const download = await fetch(`${server.baseUrl}/convert/jobs/${started.body.id as string}/download`);
    assert.ok(download.status >= 400);
  });

  it('404s an unknown job and an unknown download', async () => {
    const missing = await fetch(`${server.baseUrl}/convert/jobs/does-not-exist`);
    assert.equal(missing.status, 404);
  });
});

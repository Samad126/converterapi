/**
 * End-to-end tests for the page-manipulation endpoints: merge, split, remove
 * pages, extract pages, organize and scan-to-PDF.
 *
 * Like `integration.test.ts`, these hit the real HTTP surface with real
 * pdf-lib output - no mocks - and use `pdftotext` (poppler-utils, already a
 * required system dependency) to verify PAGE ORDER, not just page count.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PDFDocument } from 'pdf-lib';

import {
  buildJpegFixture,
  listWorkspaces,
  pdfPageText,
  postPages,
  startTestServer,
  zipEntryNames,
  type TestServer,
} from './helpers.ts';
import { buildEncryptedPdfContainer } from './fixtures.ts';

const { buildMinimalPdf, buildSolidPng } = await import('../src/lib/probe-documents.ts');

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function pageCount(pdf: Buffer): Promise<number> {
  const document = await PDFDocument.load(pdf);
  return document.getPageCount();
}

describe('POST /pdf/merge', () => {
  it('concatenates every page of every file, in upload order', async () => {
    const first = buildMinimalPdf(['A1', 'A2']);
    const second = buildMinimalPdf(['B1']);

    const response = await postPages(server.baseUrl, '/pdf/merge', [
      { filename: 'first.pdf', bytes: first },
      { filename: 'second.pdf', bytes: second },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    assert.equal(await pageCount(response.body), 3);
    assert.equal(await pdfPageText(response.body, 1), 'A1');
    assert.equal(await pdfPageText(response.body, 2), 'A2');
    assert.equal(await pdfPageText(response.body, 3), 'B1');
    assert.match(response.contentDisposition ?? '', /filename="merged\.pdf"/);
  });

  it('refuses fewer than two files', async () => {
    const response = await postPages(server.baseUrl, '/pdf/merge', [
      { filename: 'only.pdf', bytes: buildMinimalPdf(['A1']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_TOO_FEW_FILES');
  });

  it('refuses a non-PDF file with a merge-specific message', async () => {
    const response = await postPages(server.baseUrl, '/pdf/merge', [
      { filename: 'a.pdf', bytes: buildMinimalPdf(['A1']) },
      { filename: 'b.txt', bytes: Buffer.from('not a pdf') },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 415);
    assert.equal(body.error.code, 'E_UNSUPPORTED');
    assert.equal(body.error.message, 'Only .pdf files can be merged.');
  });

  it('rejects an encrypted PDF among the files', async () => {
    const response = await postPages(server.baseUrl, '/pdf/merge', [
      { filename: 'a.pdf', bytes: buildMinimalPdf(['A1']) },
      { filename: 'secret.pdf', bytes: buildEncryptedPdfContainer() },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });

  it('deletes the workspace afterwards', async () => {
    const before_ = await listWorkspaces();
    await postPages(server.baseUrl, '/pdf/merge', [
      { filename: 'a.pdf', bytes: buildMinimalPdf(['A1']) },
      { filename: 'b.pdf', bytes: buildMinimalPdf(['B1']) },
    ]);
    assert.deepEqual(await listWorkspaces(), before_);
  });
});

describe('POST /pdf/split', () => {
  it('cuts a document into chunks of "every" pages, last chunk short', async () => {
    const pdf = buildMinimalPdf(['P1', 'P2', 'P3', 'P4', 'P5']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/split',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { every: '2' },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/zip');
    const names = zipEntryNames(response.body).sort();
    assert.deepEqual(names, ['part-1.pdf', 'part-2.pdf', 'part-3.pdf']);
  });

  it('defaults to one page per file', async () => {
    const pdf = buildMinimalPdf(['P1', 'P2']);
    const response = await postPages(server.baseUrl, '/pdf/split', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
    ]);
    assert.equal(zipEntryNames(response.body).length, 2);
  });

  it('rejects a non-positive "every"', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/split',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['P1']) }],
      { every: '0' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
  });
});

describe('POST /pdf/remove-pages', () => {
  it('keeps everything except the named pages, in order', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/remove-pages',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { pages: '2' },
    );

    assert.equal(response.status, 200);
    assert.equal(await pageCount(response.body), 2);
    assert.equal(await pdfPageText(response.body, 1), 'A');
    assert.equal(await pdfPageText(response.body, 2), 'C');
  });

  it('refuses to remove every page', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/remove-pages',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A', 'B']) }],
      { pages: '1-2' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
    assert.equal(body.error.message, 'Removing these pages would leave the document empty.');
  });

  it('names a page outside the document', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/remove-pages',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A', 'B', 'C']) }],
      { pages: '9' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
    assert.equal(body.error.message, 'Page 9 does not exist in this 3-page document.');
  });

  it('requires the pages field', async () => {
    const response = await postPages(server.baseUrl, '/pdf/remove-pages', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
    assert.equal(body.error.message, 'The "pages" field is required.');
  });
});

describe('POST /pdf/extract-pages', () => {
  it('keeps only the named pages, in the order given - including reordering', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/extract-pages',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { pages: '3,1' },
    );

    assert.equal(response.status, 200);
    assert.equal(await pageCount(response.body), 2);
    assert.equal(await pdfPageText(response.body, 1), 'C');
    assert.equal(await pdfPageText(response.body, 2), 'A');
  });

  it('accepts a range', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C', 'D']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/extract-pages',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { pages: '2-3' },
    );
    assert.equal(await pageCount(response.body), 2);
    assert.equal(await pdfPageText(response.body, 1), 'B');
    assert.equal(await pdfPageText(response.body, 2), 'C');
  });
});

describe('POST /pdf/organize', () => {
  it('reorders every page, none dropped', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/organize',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { order: '3,1,2' },
    );

    assert.equal(response.status, 200);
    assert.equal(await pageCount(response.body), 3);
    assert.equal(await pdfPageText(response.body, 1), 'C');
    assert.equal(await pdfPageText(response.body, 2), 'A');
    assert.equal(await pdfPageText(response.body, 3), 'B');
  });

  it('refuses an order that drops a page', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/organize',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A', 'B', 'C']) }],
      { order: '1,2' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
    assert.match(body.error.message, /every page exactly once/);
  });

  it('refuses an order that repeats a page', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/organize',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A', 'B']) }],
      { order: '1,1' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_BAD_PAGE_RANGE');
  });
});

describe('POST /pdf/scan-to-pdf', () => {
  it('builds one page per image, sized to that image, in upload order', async () => {
    const wide = buildSolidPng(40, 10, [200, 0, 0]);
    const tall = buildSolidPng(10, 40, [0, 200, 0]);
    const jpeg = await buildJpegFixture();

    const response = await postPages(server.baseUrl, '/pdf/scan-to-pdf', [
      { filename: 'a.png', bytes: wide },
      { filename: 'b.png', bytes: tall },
      { filename: 'c.jpg', bytes: jpeg },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 3);
    const [page1, page2] = document.getPages();
    assert.equal(page1!.getWidth(), 40);
    assert.equal(page1!.getHeight(), 10);
    assert.equal(page2!.getWidth(), 10);
    assert.equal(page2!.getHeight(), 40);
  });

  it('refuses an empty request', async () => {
    const response = await postPages(server.baseUrl, '/pdf/scan-to-pdf', []);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_TOO_FEW_FILES');
  });

  it('refuses a non-image file', async () => {
    const response = await postPages(server.baseUrl, '/pdf/scan-to-pdf', [
      { filename: 'not-an-image.pdf', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 415);
    assert.equal(body.error.code, 'E_UNSUPPORTED');
    assert.equal(body.error.message, 'Only .png, .jpg and .jpeg images can be scanned to PDF.');
  });
});

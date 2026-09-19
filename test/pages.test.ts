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
import { isPasswordProtected } from '../src/lib/encrypted.ts';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('POST /pdf/rotate', () => {
  it('rotates every page by "degrees" clockwise', async () => {
    const pdf = buildMinimalPdf(['A', 'B']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/rotate',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { degrees: '90' },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 2);
    for (const page of document.getPages()) {
      assert.equal(page.getRotation().angle, 90);
    }
    // Rotation, not re-rendering: the page text is still there.
    assert.equal(await pdfPageText(response.body, 1), 'A');
  });

  it('rotates only the named pages, adding to any existing rotation', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/rotate',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { degrees: '180', pages: '2' },
    );

    const document = await PDFDocument.load(response.body);
    const angles = document.getPages().map((page) => page.getRotation().angle);
    assert.deepEqual(angles, [0, 180, 0]);
  });

  it('refuses a non-multiple-of-90 rotation', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/rotate',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { degrees: '45' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('requires the degrees field', async () => {
    const response = await postPages(server.baseUrl, '/pdf/rotate', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/watermark', () => {
  it('stamps text across every page without disturbing the original content', async () => {
    const pdf = buildMinimalPdf(['A', 'B']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/watermark',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { text: 'CONFIDENTIAL' },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 2);
    // Both the original content and the stamp have to survive - watermarking
    // adds a layer, it does not replace what was already on the page.
    const page1 = await pdfPageText(response.body, 1);
    assert.match(page1, /\bA\b/);
    assert.match(page1, /CONFIDENTIAL/);
    const page2 = await pdfPageText(response.body, 2);
    assert.match(page2, /\bB\b/);
    assert.match(page2, /CONFIDENTIAL/);
  });

  it('requires the text field', async () => {
    const response = await postPages(server.baseUrl, '/pdf/watermark', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/protect and /pdf/unlock', () => {
  it('protects a PDF so it reads as password protected', async () => {
    const pdf = buildMinimalPdf(['A']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/protect',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { password: 'sesame' },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');

    const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-protect-check-'));
    try {
      const path = join(dir, 'out.pdf');
      await fsp.writeFile(path, response.body);
      assert.equal(await isPasswordProtected(path), true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to protect an already-encrypted file', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/protect',
      [{ filename: 'secret.pdf', fieldName: 'file', bytes: buildEncryptedPdfContainer() }],
      { password: 'sesame' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });

  it('unlocks a PDF this endpoint itself protected, byte for byte the same text', async () => {
    const pdf = buildMinimalPdf(['Round', 'Trip']);
    const protectedResponse = await postPages(
      server.baseUrl,
      '/pdf/protect',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { password: 'sesame' },
    );
    assert.equal(protectedResponse.status, 200);

    const unlockedResponse = await postPages(
      server.baseUrl,
      '/pdf/unlock',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: protectedResponse.body }],
      { password: 'sesame' },
    );

    assert.equal(unlockedResponse.status, 200);
    assert.equal(await pdfPageText(unlockedResponse.body, 1), 'Round');
    assert.equal(await pdfPageText(unlockedResponse.body, 2), 'Trip');
  });

  it('refuses to unlock with the wrong password', async () => {
    const pdf = buildMinimalPdf(['A']);
    const protectedResponse = await postPages(
      server.baseUrl,
      '/pdf/protect',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { password: 'sesame' },
    );

    const response = await postPages(
      server.baseUrl,
      '/pdf/unlock',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: protectedResponse.body }],
      { password: 'wrong' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_WRONG_PASSWORD');
  });

  it('requires the password field', async () => {
    const response = await postPages(server.baseUrl, '/pdf/protect', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/crop', () => {
  it('shrinks the page by the given margins on every side', async () => {
    // buildMinimalPdf's pages are 300x150.
    const pdf = buildMinimalPdf(['A']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/crop',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { left: '10', right: '20', top: '5', bottom: '15' },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    const page = document.getPage(0);
    const box = page.getCropBox();
    assert.equal(box.x, 10);
    assert.equal(box.y, 15);
    assert.equal(box.width, 300 - 10 - 20);
    assert.equal(box.height, 150 - 5 - 15);
  });

  it('crops only the named pages', async () => {
    const pdf = buildMinimalPdf(['A', 'B']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/crop',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { left: '10', pages: '1' },
    );

    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPage(0).getCropBox().x, 10);
    assert.equal(document.getPage(1).getCropBox().x, 0);
  });

  it('defaults every margin to 0 - a no-op crop', async () => {
    const pdf = buildMinimalPdf(['A']);
    const response = await postPages(server.baseUrl, '/pdf/crop', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
    ]);
    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    const box = document.getPage(0).getCropBox();
    assert.equal(box.width, 300);
    assert.equal(box.height, 150);
  });

  it('refuses margins that would leave nothing', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/crop',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { left: '200', right: '200' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('refuses a negative margin', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/crop',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { left: '-5' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/page-numbers', () => {
  it('numbers every page starting at 1 by default', async () => {
    const pdf = buildMinimalPdf(['A', 'B', 'C']);
    const response = await postPages(server.baseUrl, '/pdf/page-numbers', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
    ]);

    assert.equal(response.status, 200);
    // The stamp is drawn near the bottom, well apart from the original text
    // near the middle - pdftotext reports them as separate lines, so check
    // both survive rather than asserting one exact concatenated string.
    assert.match(await pdfPageText(response.body, 1), /A[\s\S]*1|1[\s\S]*A/);
    assert.match(await pdfPageText(response.body, 2), /B[\s\S]*2|2[\s\S]*B/);
    assert.match(await pdfPageText(response.body, 3), /C[\s\S]*3|3[\s\S]*C/);
  });

  it('honours a custom starting number', async () => {
    const pdf = buildMinimalPdf(['A', 'B']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/page-numbers',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { startAt: '5' },
    );
    assert.match(await pdfPageText(response.body, 1), /5/);
    assert.match(await pdfPageText(response.body, 2), /6/);
  });

  it('refuses an unknown position', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/page-numbers',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { position: 'top-center' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('refuses a non-positive startAt', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/page-numbers',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { startAt: '0' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/repair', () => {
  it('rewrites a perfectly good PDF unchanged in substance', async () => {
    const pdf = buildMinimalPdf(['Hello']);
    const response = await postPages(server.baseUrl, '/pdf/repair', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    assert.equal(await pdfPageText(response.body, 1), 'Hello');
  });

  it('recovers a PDF with a damaged cross-reference table', async () => {
    // A qpdf/tests-style corruption: valid objects and trailer, but the
    // xref table's byte offsets are wrong, forcing qpdf to reconstruct it -
    // exactly the class of damage this endpoint exists for.
    const good = buildMinimalPdf(['Recovered']);
    const text = good.toString('latin1');
    const damaged = Buffer.from(
      text.replace(/^(xref\n\d+ \d+\n)([\s\S]*?)(\ntrailer)/, (_m, head, body, tail) => {
        const corruptedBody = body.replace(/^\d{10}/m, '9999999999');
        return `${head}${corruptedBody}${tail}`;
      }),
      'latin1',
    );

    const response = await postPages(server.baseUrl, '/pdf/repair', [
      { filename: 'broken.pdf', fieldName: 'file', bytes: damaged },
    ]);

    assert.equal(response.status, 200);
    assert.equal(await pdfPageText(response.body, 1), 'Recovered');
  });

  it('refuses an encrypted PDF', async () => {
    const response = await postPages(server.baseUrl, '/pdf/repair', [
      { filename: 'secret.pdf', fieldName: 'file', bytes: buildEncryptedPdfContainer() },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });
});

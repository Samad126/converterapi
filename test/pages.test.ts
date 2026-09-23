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
import { execFile } from 'node:child_process';

import { PDFDocument, StandardFonts } from 'pdf-lib';


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

const { buildMinimalPdf, buildSolidPng, pdfScannedProbe } = await import('../src/lib/probe-documents.ts');

/**
 * `ocrmypdf` shells out to `tesseract` for the actual character recognition.
 * It is installed in this sandbox, `tesseract` is not - so any test that
 * needs OCR to genuinely SUCCEED (as opposed to the force=false passthrough,
 * which never touches an OCR engine at all) is skipped rather than failed
 * when it is missing, the same way the rest of this suite treats a missing
 * optional system dependency.
 */
let tesseractAvailable: boolean | undefined;
async function hasTesseract(): Promise<boolean> {
  if (tesseractAvailable !== undefined) return tesseractAvailable;
  tesseractAvailable = await new Promise<boolean>((resolve) => {
    execFile('tesseract', ['--version'], (error) => resolve(!error));
  });
  return tesseractAvailable;
}

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

describe('POST /pdf/compress', () => {
  it('compresses a normal PDF at the default level without losing content', async () => {
    const original = buildMinimalPdf(['Hello', 'World']);
    const response = await postPages(server.baseUrl, '/pdf/compress', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: original },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    assert.ok(response.body.length <= original.length);
    assert.equal(await pageCount(response.body), 2);
    assert.equal(await pdfPageText(response.body, 1), 'Hello');
    assert.equal(await pdfPageText(response.body, 2), 'World');
  });

  for (const level of ['low', 'medium', 'high']) {
    it(`accepts level=${level} and produces a valid PDF`, async () => {
      const original = buildMinimalPdf(['A']);
      const response = await postPages(
        server.baseUrl,
        '/pdf/compress',
        [{ filename: 'doc.pdf', fieldName: 'file', bytes: original }],
        { level },
      );

      assert.equal(response.status, 200);
      assert.equal(response.contentType, 'application/pdf');
      assert.equal(await pageCount(response.body), 1);
      assert.equal(await pdfPageText(response.body, 1), 'A');
    });
  }

  it('rejects an invalid level', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/compress',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { level: 'extreme' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('refuses an already-encrypted PDF', async () => {
    const response = await postPages(server.baseUrl, '/pdf/compress', [
      { filename: 'secret.pdf', fieldName: 'file', bytes: buildEncryptedPdfContainer() },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });
});

describe('POST /pdf/ocr', () => {
  it('passes a PDF that already has text through unchanged when force is not set', async () => {
    const pdf = buildMinimalPdf(['Already searchable']);
    const response = await postPages(server.baseUrl, '/pdf/ocr', [
      { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    // No OCR engine involved for this path at all - the text was already
    // there, so this is a plain copy, verifiable without tesseract.
    assert.equal(await pdfPageText(response.body, 1), 'Already searchable');
  });

  it('passes a PDF that already has text through unchanged when force is explicitly false', async () => {
    // At least 10 characters: `_pdf_has_no_extractable_text` in
    // pdf_engine.py treats anything shorter as "probably just a stray page
    // number", the same threshold documented there.
    const pdf = buildMinimalPdf(['This is a real text page']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/ocr',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { force: 'false' },
    );
    assert.equal(response.status, 200);
    assert.equal(await pdfPageText(response.body, 1), 'This is a real text page');
  });

  it('OCRs a scanned PDF with no extractable text when tesseract is available', async () => {
    if (!(await hasTesseract())) return; // See hasTesseract() above.
    const scanned = pdfScannedProbe();
    const inputPageCount = await pageCount(scanned);

    const response = await postPages(server.baseUrl, '/pdf/ocr', [
      { filename: 'scan.pdf', fieldName: 'file', bytes: scanned },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');
    assert.equal(await pageCount(response.body), inputPageCount);
  });

  it('force=true re-OCRs even a PDF that already has text, when tesseract is available', async () => {
    if (!(await hasTesseract())) return;
    const pdf = buildMinimalPdf(['Force me']);
    const inputPageCount = await pageCount(pdf);

    const response = await postPages(
      server.baseUrl,
      '/pdf/ocr',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { force: 'true' },
    );

    assert.equal(response.status, 200);
    assert.equal(await pageCount(response.body), inputPageCount);
  });

  it('rejects a non-boolean force field', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/ocr',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { force: 'maybe' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('refuses an encrypted PDF', async () => {
    const response = await postPages(server.baseUrl, '/pdf/ocr', [
      { filename: 'secret.pdf', fieldName: 'file', bytes: buildEncryptedPdfContainer() },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });
});

/** Build a small real PDF whose AcroForm has one text field and one checkbox. */
async function buildFormPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 150]);
  const form = document.getForm();

  const textField = form.createTextField('name');
  textField.setText('');
  textField.addToPage(page, { x: 20, y: 100, width: 150, height: 20 });

  const checkbox = form.createCheckBox('agree');
  checkbox.addToPage(page, { x: 20, y: 60, width: 20, height: 20 });

  return Buffer.from(await document.save());
}

describe('POST /pdf/form-fields', () => {
  it('lists every AcroForm field with its type', async () => {
    const pdf = await buildFormPdf();
    const response = await postPages(server.baseUrl, '/pdf/form-fields', [
      { filename: 'form.pdf', fieldName: 'file', bytes: pdf },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/json');
    const fields = JSON.parse(response.body.toString('utf8'));
    assert.equal(Array.isArray(fields), true);
    const byName = Object.fromEntries(fields.map((f: { name: string }) => [f.name, f]));
    assert.equal(byName.name.type, 'text');
    assert.equal(byName.agree.type, 'checkbox');
    assert.equal(byName.agree.value, false);
  });

  it('returns an empty array for a PDF with no form', async () => {
    const pdf = buildMinimalPdf(['No form here']);
    const response = await postPages(server.baseUrl, '/pdf/form-fields', [
      { filename: 'plain.pdf', fieldName: 'file', bytes: pdf },
    ]);

    assert.equal(response.status, 200);
    const fields = JSON.parse(response.body.toString('utf8'));
    assert.deepEqual(fields, []);
  });
});

describe('POST /pdf/fill-form', () => {
  it('fills a text field and a checkbox, and the values round-trip', async () => {
    const pdf = await buildFormPdf();
    const response = await postPages(
      server.baseUrl,
      '/pdf/fill-form',
      [{ filename: 'form.pdf', fieldName: 'file', bytes: pdf }],
      { fields: JSON.stringify({ name: 'Ada Lovelace', agree: true }) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');

    const document = await PDFDocument.load(response.body);
    const form = document.getForm();
    assert.equal(form.getTextField('name').getText(), 'Ada Lovelace');
    assert.equal(form.getCheckBox('agree').isChecked(), true);
  });

  it('flattening removes the fields, leaving the values as page content', async () => {
    const pdf = await buildFormPdf();
    const response = await postPages(
      server.baseUrl,
      '/pdf/fill-form',
      [{ filename: 'form.pdf', fieldName: 'file', bytes: pdf }],
      { fields: JSON.stringify({ name: 'Flattened' }), flatten: 'true' },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getForm().getFields().length, 0);
  });

  it('rejects an unknown field name', async () => {
    const pdf = await buildFormPdf();
    const response = await postPages(
      server.baseUrl,
      '/pdf/fill-form',
      [{ filename: 'form.pdf', fieldName: 'file', bytes: pdf }],
      { fields: JSON.stringify({ nope: 'x' }) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects malformed JSON in the fields field', async () => {
    const pdf = await buildFormPdf();
    const response = await postPages(
      server.baseUrl,
      '/pdf/fill-form',
      [{ filename: 'form.pdf', fieldName: 'file', bytes: pdf }],
      { fields: '{not json' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/compare', () => {
  it('reports every shared page as equal for two identical PDFs', async () => {
    const a = buildMinimalPdf(['Page one', 'Page two']);
    const b = buildMinimalPdf(['Page one', 'Page two']);

    const response = await postPages(server.baseUrl, '/pdf/compare', [
      { filename: 'a.pdf', bytes: a },
      { filename: 'b.pdf', bytes: b },
    ]);

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/json');
    const report = JSON.parse(response.body.toString('utf8'));
    assert.equal(report.pageCountA, 2);
    assert.equal(report.pageCountB, 2);
    assert.equal(report.pages.every((p: { equal: boolean }) => p.equal), true);
    assert.deepEqual(report.extraPagesInA, []);
    assert.deepEqual(report.extraPagesInB, []);
  });

  it('reports a non-equal diff for a page whose text changed', async () => {
    const a = buildMinimalPdf(['Hello world']);
    const b = buildMinimalPdf(['Goodbye world']);

    const response = await postPages(server.baseUrl, '/pdf/compare', [
      { filename: 'a.pdf', bytes: a },
      { filename: 'b.pdf', bytes: b },
    ]);

    assert.equal(response.status, 200);
    const report = JSON.parse(response.body.toString('utf8'));
    assert.equal(report.pages[0].equal, false);
    assert.equal(Array.isArray(report.pages[0].diff), true);
    const ops = report.pages[0].diff.map((d: { op: string }) => d.op);
    assert.equal(ops.includes('equal') || ops.includes('replace') || ops.includes('insert') || ops.includes('delete'), true);
  });

  it('reports extra pages on the longer document', async () => {
    const a = buildMinimalPdf(['Only page']);
    const b = buildMinimalPdf(['Only page', 'Extra page']);

    const response = await postPages(server.baseUrl, '/pdf/compare', [
      { filename: 'a.pdf', bytes: a },
      { filename: 'b.pdf', bytes: b },
    ]);

    assert.equal(response.status, 200);
    const report = JSON.parse(response.body.toString('utf8'));
    assert.deepEqual(report.extraPagesInA, []);
    assert.deepEqual(report.extraPagesInB, [2]);
  });

  it('refuses a single file', async () => {
    const response = await postPages(server.baseUrl, '/pdf/compare', [
      { filename: 'a.pdf', bytes: buildMinimalPdf(['A']) },
    ]);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_TOO_FEW_FILES');
  });

  it('refuses three files', async () => {
    const response = await postPages(server.baseUrl, '/pdf/compare', [
      { filename: 'a.pdf', bytes: buildMinimalPdf(['A']) },
      { filename: 'b.pdf', bytes: buildMinimalPdf(['B']) },
      { filename: 'c.pdf', bytes: buildMinimalPdf(['C']) },
    ]);
    assert.equal(response.status, 400);
  });
});

/**
 * `pdftotext -bbox` (poppler-utils, already required) reports each word's
 * bounding box in an HTML/XML dump, in the SAME top-left-origin coordinate
 * system `/pdf/sign`'s `x`/`y`/`width`/`height` are specified in - which
 * makes it the tool for verifying the coordinate flip actually lands text
 * where a caller asked for it, rather than trusting the `H - y - height`
 * arithmetic in `signPdf` on faith.
 */
async function pdfWordBoxes(
  pdf: Buffer,
  pageNumber: number,
): Promise<Array<{ word: string; xMin: number; yMin: number; xMax: number; yMax: number }>> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-sign-bbox-'));
  try {
    const inPath = join(dir, 'in.pdf');
    await fsp.writeFile(inPath, pdf);
    const xml = await new Promise<string>((resolve, reject) => {
      execFile(
        'pdftotext',
        ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), inPath, '-'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const boxes: Array<{ word: string; xMin: number; yMin: number; xMax: number; yMax: number }> = [];
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    for (const match of xml.matchAll(wordRe)) {
      boxes.push({
        xMin: Number(match[1]),
        yMin: Number(match[2]),
        xMax: Number(match[3]),
        yMax: Number(match[4]),
        word: match[5]!,
      });
    }
    return boxes;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('POST /pdf/sign', () => {
  it('places a typed "name" element at roughly the requested top-left position', async () => {
    // A tall page and a box near the top so top-vs-bottom mistakes in the
    // coordinate flip are obvious rather than accidentally close either way.
    const pdf = buildMinimalPdf(['Original']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      {
        elements: JSON.stringify([
          { type: 'name', page: 1, x: 50, y: 40, width: 200, height: 30, value: 'Ada Lovelace' },
        ]),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');

    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 1);
    const original = await pdfPageText(response.body, 1);
    assert.match(original, /Original/);
    assert.match(original, /Ada/);

    const boxes = await pdfWordBoxes(response.body, 1);
    const word = boxes.find((b) => b.word.includes('Ada'));
    assert.ok(word, 'expected to find the word "Ada" in the page bounding boxes');
    // Requested top-left y was 40, box height 30: the text should land near
    // the top of that box (well above the page's lower half), not near the
    // bottom of the page the way an un-flipped coordinate would put it.
    assert.ok(word!.yMin >= 30 && word!.yMax <= 90, `expected y around 40-70, got ${word!.yMin}-${word!.yMax}`);
    assert.ok(word!.xMin >= 40 && word!.xMin <= 120, `expected x around 50, got ${word!.xMin}`);
  });

  it('a typed signature succeeds with each fontStyle', async () => {
    for (const fontStyle of ['cursive', 'cursive2', 'plain']) {
      const pdf = buildMinimalPdf(['Doc']);
      const response = await postPages(
        server.baseUrl,
        '/pdf/sign',
        [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
        {
          elements: JSON.stringify([
            { type: 'signature', page: 1, x: 20, y: 20, width: 180, height: 50, value: 'Ada L.', fontStyle },
          ]),
        },
      );
      assert.equal(response.status, 200, `fontStyle=${fontStyle}`);
      const document = await PDFDocument.load(response.body);
      assert.equal(document.getPageCount(), 1);
    }
  });

  it('supports color on a typed element', async () => {
    const pdf = buildMinimalPdf(['Doc']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      {
        elements: JSON.stringify([
          { type: 'text', page: 1, x: 20, y: 20, width: 180, height: 30, value: 'Approved', color: 'red' },
        ]),
      },
    );
    assert.equal(response.status, 200);
  });

  it('a "stamp" element using an uploaded PNG lands on the right page', async () => {
    const pdf = buildMinimalPdf(['Page one', 'Page two']);
    const stamp = buildSolidPng(40, 40, [200, 0, 0]);
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [
        { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
        { filename: 'stamp.png', fieldName: 'images', bytes: stamp },
      ],
      {
        elements: JSON.stringify([{ type: 'stamp', page: 2, x: 10, y: 10, width: 40, height: 40, imageIndex: 0 }]),
      },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 2);
    // The stamp is an image, not text, so pdftotext on its own page should
    // still show only the original page content - the useful check here is
    // that the request succeeded and the document is otherwise intact.
    assert.match(await pdfPageText(response.body, 1), /Page one/);
    assert.match(await pdfPageText(response.body, 2), /Page two/);
  });

  it('a drawn/uploaded "signature" element (imageIndex) succeeds', async () => {
    const pdf = buildMinimalPdf(['Doc']);
    const sig = buildSolidPng(100, 30, [0, 0, 0]);
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [
        { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
        { filename: 'sig.png', fieldName: 'images', bytes: sig },
      ],
      {
        elements: JSON.stringify([
          { type: 'signature', page: 1, x: 10, y: 10, width: 100, height: 30, imageIndex: 0 },
        ]),
      },
    );
    assert.equal(response.status, 200);
  });

  it('rejects an element missing both value and imageIndex', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'signature', page: 1, x: 0, y: 0, width: 10, height: 10 }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects an element with both value and imageIndex', async () => {
    const stamp = buildSolidPng(10, 10, [0, 0, 0]);
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [
        { filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) },
        { filename: 'stamp.png', fieldName: 'images', bytes: stamp },
      ],
      {
        elements: JSON.stringify([
          { type: 'signature', page: 1, x: 0, y: 0, width: 10, height: 10, value: 'X', imageIndex: 0 },
        ]),
      },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects an unknown element type', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'bogus', page: 1, x: 0, y: 0, width: 10, height: 10, value: 'x' }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects an imageIndex that was not uploaded', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      {
        elements: JSON.stringify([
          { type: 'stamp', page: 1, x: 0, y: 0, width: 10, height: 10, imageIndex: 0 },
        ]),
      },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects a page beyond the document page count', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      {
        elements: JSON.stringify([{ type: 'text', page: 5, x: 0, y: 0, width: 10, height: 10, value: 'x' }]),
      },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects malformed JSON in the elements field', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/sign',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: '{not json' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

describe('POST /pdf/edit', () => {
  it('places a "text" element at roughly the requested top-left position', async () => {
    const pdf = buildMinimalPdf(['Original']);
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      {
        elements: JSON.stringify([{ type: 'text', page: 1, x: 50, y: 40, value: 'Comment', fontSize: 14 }]),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');

    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 1);
    assert.match(await pdfPageText(response.body, 1), /Original/);
    assert.match(await pdfPageText(response.body, 1), /Comment/);

    const boxes = await pdfWordBoxes(response.body, 1);
    const word = boxes.find((b) => b.word.includes('Comment'));
    assert.ok(word, 'expected to find the word "Comment" in the page bounding boxes');
    // Anchored by the top of a 14pt box at top-left y=40: near the top of
    // the page, not the bottom an un-flipped coordinate would put it at.
    assert.ok(word!.yMin >= 30 && word!.yMax <= 70, `expected y around 40-54, got ${word!.yMin}-${word!.yMax}`);
    assert.ok(word!.xMin >= 40 && word!.xMin <= 120, `expected x around 50, got ${word!.xMin}`);
  });

  it('supports color on a text element', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['Doc']) }],
      { elements: JSON.stringify([{ type: 'text', page: 1, x: 20, y: 20, value: 'Note', color: 'orange' }]) },
    );
    assert.equal(response.status, 200);
  });

  it('an "image" element using an uploaded PNG lands on the right page', async () => {
    const pdf = buildMinimalPdf(['Page one', 'Page two']);
    const stamp = buildSolidPng(40, 40, [0, 128, 0]);
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [
        { filename: 'doc.pdf', fieldName: 'file', bytes: pdf },
        { filename: 'stamp.png', fieldName: 'images', bytes: stamp },
      ],
      {
        elements: JSON.stringify([{ type: 'image', page: 2, x: 10, y: 10, width: 40, height: 40, imageIndex: 0 }]),
      },
    );

    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 2);
    assert.match(await pdfPageText(response.body, 1), /Page one/);
    assert.match(await pdfPageText(response.body, 2), /Page two/);
  });

  it('draws a filled rectangle, an outlined ellipse, a line and a freehand stroke', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['Doc']) }],
      {
        elements: JSON.stringify([
          { type: 'rectangle', page: 1, x: 10, y: 10, width: 50, height: 20, color: 'red', fill: true },
          { type: 'ellipse', page: 1, x: 10, y: 40, width: 50, height: 20, color: 'blue', strokeWidth: 3 },
          { type: 'line', page: 1, x1: 10, y1: 70, x2: 100, y2: 70, color: 'green' },
          {
            type: 'freehand',
            page: 1,
            color: 'black',
            points: [
              { x: 10, y: 90 },
              { x: 20, y: 95 },
              { x: 30, y: 90 },
            ],
          },
        ]),
      },
    );
    assert.equal(response.status, 200);
    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 1);
  });

  it('rejects an unknown element type', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'bogus', page: 1, x: 0, y: 0 }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects a "text" element missing "value"', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'text', page: 1, x: 0, y: 0 }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects an "image" element with an imageIndex that was not uploaded', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      {
        elements: JSON.stringify([
          { type: 'image', page: 1, x: 0, y: 0, width: 10, height: 10, imageIndex: 0 },
        ]),
      },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects a "freehand" element with fewer than 2 points', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'freehand', page: 1, points: [{ x: 0, y: 0 }] }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects a page beyond the document page count', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: JSON.stringify([{ type: 'text', page: 5, x: 0, y: 0, value: 'x' }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects malformed JSON in the elements field', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/edit',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: buildMinimalPdf(['A']) }],
      { elements: '{not json' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });
});

/**
 * A one-page, 300x300pt PDF with two well-separated, distinctly-named text
 * strings drawn via `pdf-lib`'s own `drawText` at known baseline positions -
 * `buildMinimalPdf` (used by every other test above) only supports a single
 * line per page at a fixed position, which is not enough control to reliably
 * target one piece of text with a redaction rectangle while leaving another
 * untouched. `pdf-lib` coordinates are bottom-left origin (y counts up from
 * the bottom), which is NOT what `/pdf/redact`'s API or its engine (PyMuPDF)
 * use - both are top-left origin - so this helper hands back each string's
 * bounding box already converted to top-left, ready to pass straight to
 * `/pdf/redact`'s `areas`.
 */
async function buildRedactFixture(): Promise<{
  pdf: Buffer;
  pageHeight: number;
  secretBox: { x: number; y: number; width: number; height: number };
  keepBox: { x: number; y: number; width: number; height: number };
}> {
  const pageWidth = 300;
  const pageHeight = 300;
  const fontSize = 14;
  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidth, pageHeight]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const secretText = 'CLASSIFIEDSECRET';
  const keepText = 'PublicKeepThis';
  const secretBaselineY = 250; // near the top of the page, bottom-left-origin
  const keepBaselineY = 30; // near the bottom of the page, bottom-left-origin
  const x = 20;

  page.drawText(secretText, { x, y: secretBaselineY, size: fontSize, font });
  page.drawText(keepText, { x, y: keepBaselineY, size: fontSize, font });

  const secretWidth = font.widthOfTextAtSize(secretText, fontSize);
  const keepWidth = font.widthOfTextAtSize(keepText, fontSize);
  // A generous vertical pad around each baseline (ascender/descender room),
  // converted from pdf-lib's bottom-left y to the top-left y this endpoint's
  // `areas` field expects: topY = pageHeight - bottomY - boxHeight.
  const pad = 6;
  const boxHeight = fontSize + pad * 2;

  const secretBox = {
    x: x - 4,
    y: pageHeight - (secretBaselineY + fontSize + pad),
    width: secretWidth + 8,
    height: boxHeight,
  };
  const keepBox = {
    x: x - 4,
    y: pageHeight - (keepBaselineY + fontSize + pad),
    width: keepWidth + 8,
    height: boxHeight,
  };

  return { pdf: Buffer.from(await doc.save()), pageHeight, secretBox, keepBox };
}

describe('POST /pdf/redact', () => {
  it('genuinely removes the redacted text - it is absent from extracted text, not merely covered', async () => {
    const { pdf, secretBox } = await buildRedactFixture();

    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: JSON.stringify([{ page: 1, ...secretBox }]) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/pdf');

    const document = await PDFDocument.load(response.body);
    assert.equal(document.getPageCount(), 1);

    const text = await pdfPageText(response.body, 1);
    // The core "not fake" assertion: the redacted string must not survive
    // ANYWHERE in the extracted text, not just be visually hidden.
    assert.doesNotMatch(text, /CLASSIFIEDSECRET/);
    // Text elsewhere on the same page is untouched.
    assert.match(text, /PublicKeepThis/);
  });

  it('redacts multiple areas across multiple pages in one request', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pageWidth = 300;
    const pageHeight = 300;
    const fontSize = 14;

    // Page 1: SECRETONE (top) + KEEPONE (bottom). Page 2: SECRETTWO (top) + KEEPTWO (bottom).
    const boxes: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
    for (const [secretText, keepText] of [
      ['SECRETONE', 'KEEPONE'],
      ['SECRETTWO', 'KEEPTWO'],
    ] as const) {
      const page = doc.addPage([pageWidth, pageHeight]);
      const pageNumber = doc.getPageCount();
      const secretBaselineY = 250;
      const keepBaselineY = 30;
      const x = 20;
      page.drawText(secretText, { x, y: secretBaselineY, size: fontSize, font });
      page.drawText(keepText, { x, y: keepBaselineY, size: fontSize, font });

      const secretWidth = font.widthOfTextAtSize(secretText, fontSize);
      const pad = 6;
      const boxHeight = fontSize + pad * 2;
      boxes.push({
        page: pageNumber,
        x: x - 4,
        y: pageHeight - (secretBaselineY + fontSize + pad),
        width: secretWidth + 8,
        height: boxHeight,
      });
    }

    const pdf = Buffer.from(await doc.save());
    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: JSON.stringify(boxes) },
    );

    assert.equal(response.status, 200);
    const page1Text = await pdfPageText(response.body, 1);
    const page2Text = await pdfPageText(response.body, 2);
    assert.doesNotMatch(page1Text, /SECRETONE/);
    assert.match(page1Text, /KEEPONE/);
    assert.doesNotMatch(page2Text, /SECRETTWO/);
    assert.match(page2Text, /KEEPTWO/);
  });

  it('rejects a page beyond the document page count without invoking the engine', async () => {
    const { pdf } = await buildRedactFixture();
    const before_ = await listWorkspaces();

    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: JSON.stringify([{ page: 5, x: 0, y: 0, width: 10, height: 10 }]) },
    );

    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
    // The request never got far enough to spawn pdf_engine.py at all - the
    // failure is a synchronous validation error, not a workspace left behind
    // by a Python process that happened to fail fast on the same bad input.
    assert.deepEqual(await listWorkspaces(), before_);
  });

  it('rejects malformed JSON in the areas field', async () => {
    const { pdf } = await buildRedactFixture();
    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: '{not json' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects an empty areas array', async () => {
    const { pdf } = await buildRedactFixture();
    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: '[]' },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'E_INVALID_FIELD');
  });

  it('rejects non-positive width/height', async () => {
    const { pdf } = await buildRedactFixture();
    for (const bad of [
      { page: 1, x: 0, y: 0, width: 0, height: 10 },
      { page: 1, x: 0, y: 0, width: 10, height: -5 },
    ]) {
      const response = await postPages(
        server.baseUrl,
        '/pdf/redact',
        [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
        { areas: JSON.stringify([bad]) },
      );
      const body = JSON.parse(response.body.toString('utf8'));
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.equal(body.error.code, 'E_INVALID_FIELD');
    }
  });

  it('rejects an encrypted upload', async () => {
    const response = await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'secret.pdf', fieldName: 'file', bytes: buildEncryptedPdfContainer() }],
      { areas: JSON.stringify([{ page: 1, x: 0, y: 0, width: 10, height: 10 }]) },
    );
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'E_ENCRYPTED');
  });

  it('deletes the workspace afterwards', async () => {
    const { pdf, secretBox } = await buildRedactFixture();
    const before_ = await listWorkspaces();
    await postPages(
      server.baseUrl,
      '/pdf/redact',
      [{ filename: 'doc.pdf', fieldName: 'file', bytes: pdf }],
      { areas: JSON.stringify([{ page: 1, ...secretBox }]) },
    );
    assert.deepEqual(await listWorkspaces(), before_);
  });
});

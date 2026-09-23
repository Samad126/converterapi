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
} from '../../support/helpers.ts';
import { buildEncryptedPdfContainer } from '../../support/fixtures.ts';
import { isPasswordProtected } from '../../../src/lib/encrypted.ts';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildMinimalPdf, buildSolidPng, pdfScannedProbe } = await import('../../../src/lib/probe-documents.ts');

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

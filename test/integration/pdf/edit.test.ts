import { pdfWordBoxes } from '../../support/pdf-fixtures.ts';
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

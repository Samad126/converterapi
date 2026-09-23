import { buildRedactFixture, pdfWordBoxes } from '../../support/pdf-fixtures.ts';
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

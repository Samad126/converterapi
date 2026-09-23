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

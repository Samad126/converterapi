import { buildFormPdf } from '../../support/pdf-fixtures.ts';
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

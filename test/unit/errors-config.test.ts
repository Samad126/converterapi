/**
 * Unit tests for the parts that are worth pinning down without a subprocess:
 * the conversion matrix, the concurrency bound, the rate limiter, password
 * detection, the ZIP writer, and the exact user-facing strings.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before config.ts is imported - see the note in helpers.ts.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-unit-'));

const { BoundedQueue, RateLimiter } = await import('../../src/lib/queue.ts');
const { Errors, AppError, ClientGoneError } = await import('../../src/errors.ts');
const {
  ALLOWED_EXTENSIONS,
  SOURCES,
  TARGETS,
  TARGET_IDS,
  isAllowedExtension,
  isTargetId,
  pdfFilterFor,
  resolveConversion,
  targetsFor,
  validateMatrix,
} = await import('../../src/formats.ts');
const { isPasswordProtected } = await import('../../src/lib/encrypted.ts');
const {
  createWorkspace,
  removeWorkspace,
  sweepStaleWorkspaces,
  inputFileNameFor,
} = await import('../../src/services/workspace.service.ts');
const { zipStored, safeEntryName } = await import('../../src/lib/zip.ts');
const { EXTRACT_TARGET_IDS } = await import('../../src/pipelines/conversion.pipeline.ts');
const { decodeUploadName, downloadNameFor, contentDispositionFor } = await import(
  '../../src/lib/download-name.ts'
);
const { buildMinimalDocx, buildMinimalOdp, buildSolidPng, pdfProbe } = await import(
  '../../src/lib/probe-documents.ts'
);
const { MAX_UPLOAD_BYTES, MAX_DOWNLOAD_NAME_LENGTH, TEMP_ROOT } = await import(
  '../../src/config.ts'
);
const {
  buildEncryptedDocxContainer,
  buildEncryptedLegacyDoc,
  buildEncryptedPdfContainer,
  buildFormerlyEncryptedPdf,
  buildPlainLegacyDoc,
} = await import('../support/fixtures.ts');

after(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true });
});

describe('error envelope', () => {
  it('carries the exact code, status and verbatim message for every case', () => {
    const cases: Array<[InstanceType<typeof AppError>, number, string, string]> = [
      [
        Errors.convertFailed(),
        500,
        'E_CONVERT_FAILED',
        'This document could not be converted. It may be damaged or in a format the converter does not support.',
      ],
      [Errors.timeout(), 504, 'E_TIMEOUT', 'This document took too long to convert.'],
      [Errors.encrypted(), 422, 'E_ENCRYPTED', 'This document is password protected.'],
      [
        Errors.unsupportedTarget('.docx', ['pdf', 'odt']),
        415,
        'E_UNSUPPORTED_TARGET',
        'A .docx file can be converted to: PDF, ODT.',
      ],
      [
        Errors.unknownTarget(['pdf', 'csv']),
        404,
        'E_UNKNOWN_TARGET',
        'That is not a format this converter can produce. Available: PDF, CSV.',
      ],
      [Errors.tooLarge(), 413, 'E_TOO_LARGE', 'This document is too large to convert.'],
      [Errors.busy(), 503, 'E_BUSY', 'The converter is busy. Try again in a moment.'],
    ];

    for (const [error, status, code, message] of cases) {
      assert.equal(error.status, status);
      assert.deepEqual(error.toEnvelope(), { error: { code, message } });
    }
  });

  it('writes messages for people, not for logs', () => {
    // Every error, with the arguments a real request would give it - the point
    // is the RENDERED sentence, so a factory that leaks a raw argument into the
    // text would be caught here.
    const samples: Array<InstanceType<typeof AppError>> = [
      Errors.convertFailed(),
      Errors.timeout(),
      Errors.encrypted(),
      Errors.unsupported(),
      Errors.unsupportedTarget('.docx', ['pdf', 'odt', 'txt']),
      Errors.unknownTarget(['pdf', 'odt']),
      Errors.tooLarge(),
      Errors.busy(),
      Errors.badRequest('no file part named "file"'),
      Errors.rateLimited(),
      Errors.internal(),
    ];

    for (const error of samples) {
      const produced = error.toEnvelope().error.message;
      assert.match(produced, /[.!?]$/, `not a sentence: ${produced}`);
      assert.doesNotMatch(produced, /\/|stack|Error:|undefined|null/i, `leaks internals: ${produced}`);
      // No codes in the text: the code is for logs only.
      assert.doesNotMatch(produced, /E_[A-Z_]+/, `mentions a code: ${produced}`);
    }
  });

  it('names what a document COULD become, not just that it failed', () => {
    // The useful answer to "can I have this as PNG" is what you can have instead.
    const message = Errors.unsupportedTarget('.docx', targetsFor('.docx')).toEnvelope()
      .error.message;
    assert.match(message, /PDF, ODT, TXT, HTML, RTF, EPUB/);
  });
});

describe('password-protected detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createWorkspace();
  });

  const write = async (name: string, bytes: Buffer): Promise<string> => {
    const path = join(dir, name);
    await fsp.writeFile(path, bytes);
    return path;
  };

  it('detects an encrypted OOXML package', async () => {
    const path = await write('a.docx', buildEncryptedDocxContainer());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('detects the fEncrypted flag on a legacy .doc', async () => {
    const path = await write('a.doc', buildEncryptedLegacyDoc());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('leaves an unencrypted legacy .doc alone', async () => {
    const path = await write('a.doc', buildPlainLegacyDoc());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('leaves a normal .docx alone', async () => {
    const path = await write('a.docx', buildMinimalDocx(['hello']));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('detects a PDF whose trailer names an /Encrypt dictionary', async () => {
    const path = await write('a.pdf', buildEncryptedPdfContainer());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('leaves a normal PDF alone', async () => {
    const path = await write('a.pdf', pdfProbe());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not mistake a stale /Encrypt from an earlier revision for a current one', async () => {
    // The bug this regression test pins: a whole-file search for "/Encrypt"
    // finds one in this fixture's FIRST revision, but the file's current
    // trailer (the one `startxref` actually points at) has no /Encrypt at
    // all - the password was removed by a later incremental save. Reporting
    // this as encrypted would reject a document soffice could convert fine.
    const path = await write('a.pdf', buildFormerlyEncryptedPdf());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('leaves an ODP alone', async () => {
    // An ODF package is a zip, so it can never be a CFB container - the
    // detector must not misread the prefix of a zip as one.
    const path = await write('a.odp', buildMinimalOdp(['one']));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not claim garbage is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(256, 0x41));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not claim an empty file is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(0));
    assert.equal(await isPasswordProtected(path), false);
  });
});

describe('config', () => {
  it('caps uploads at the 100MB the client also enforces', () => {
    assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
  });

  it('names the on-disk upload from the validated extension only', () => {
    assert.equal(inputFileNameFor('.docx'), 'input.docx');
    assert.equal(inputFileNameFor('.odp'), 'input.odp');
    assert.equal(inputFileNameFor('.csv'), 'input.csv');
  });
});

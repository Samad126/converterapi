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

describe('zip writer', () => {
  it('round-trips entry names through the central directory', () => {
    const archive = zipStored([
      { name: 'slide-1.png', data: Buffer.from('one') },
      { name: 'slide-2.png', data: Buffer.from('two') },
    ]);
    // Signature of the first local file header, and the end-of-central-directory
    // magic somewhere at the end.
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.ok(archive.subarray(-22).readUInt32LE(0) === 0x06054b50);
    assert.ok(archive.includes(Buffer.from('slide-1.png')));
    assert.ok(archive.includes(Buffer.from('slide-2.png')));
  });

  it('refuses to write a name that could escape on unpack', () => {
    // Zip-slip defence: the archive is ours, but a name is a name.
    assert.equal(safeEntryName('../../etc/passwd'), 'etc/passwd');
    assert.equal(safeEntryName('/absolute/path.txt'), 'absolute/path.txt');
    assert.equal(safeEntryName('..'), 'file');
    assert.equal(safeEntryName(''), 'file');
    assert.equal(safeEntryName('a/./b.txt'), 'a/b.txt');
  });
});

describe('probe documents', () => {
  it('builds a docx that is a real OOXML package', () => {
    const docx = buildMinimalDocx(['hello']);
    assert.equal(docx.readUInt32LE(0), 0x04034b50, 'not a zip');
    assert.ok(docx.includes(Buffer.from('[Content_Types].xml')));
    assert.ok(docx.includes(Buffer.from('word/document.xml')));
  });

  it('builds an ODP whose mimetype entry comes first and is stored', () => {
    const odp = buildMinimalOdp(['one', 'two']);
    assert.equal(odp.readUInt32LE(0), 0x04034b50, 'not a zip');
    // ODF requires the mimetype entry first, and stored rather than deflated -
    // it is how a consumer recognises the format from the first bytes.
    const nameLength = odp.readUInt16LE(26);
    const name = odp.subarray(30, 30 + nameLength).toString('utf8');
    assert.equal(name, 'mimetype');
    assert.equal(odp.readUInt16LE(8), 0, 'mimetype entry must not be compressed');
    assert.ok(odp.includes(Buffer.from('application/vnd.oasis.opendocument.presentation')));
  });

  it('builds a PNG with a valid signature and IHDR', () => {
    const png = buildSolidPng(4, 3, [10, 20, 30]);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(png.readUInt32BE(16), 4, 'width');
    assert.equal(png.readUInt32BE(20), 3, 'height');
  });
});

describe('BoundedQueue', () => {
  it('never runs more than maxConcurrent jobs at once', async () => {
    const queue = new BoundedQueue(2, 10);
    let running = 0;
    let peak = 0;

    const job = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    };

    await Promise.all(Array.from({ length: 12 }, () => queue.run(undefined, job)));
    assert.equal(peak, 2);
    assert.equal(queue.stats().running, 0);
    assert.equal(queue.stats().queued, 0);
  });

  it('rejects with E_BUSY once the waiting room is full', async () => {
    const queue = new BoundedQueue(1, 1);
    const release = { resolve: () => {} } as { resolve: () => void };
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });

    const first = queue.run(undefined, () => blocker); // takes the only slot
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = queue.run(undefined, () => blocker); // takes the only queue seat
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      () => queue.run(undefined, async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'E_BUSY');
        assert.equal(error.status, 503);
        return true;
      },
    );

    release.resolve();
    await Promise.all([first, second]);
  });

  it('hasCapacity reports whether another request would be admitted', async () => {
    const queue = new BoundedQueue(1, 0);
    assert.equal(queue.hasCapacity(), true);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = queue.run(undefined, () => blocker);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // One slot busy, no waiting room: the next request must be shed.
    assert.equal(queue.hasCapacity(), false);
    release();
    await running;
    assert.equal(queue.hasCapacity(), true);
  });

  it('releases the slot when the job throws', async () => {
    const queue = new BoundedQueue(1, 0);
    await assert.rejects(() => queue.run(undefined, async () => Promise.reject(new Error('boom'))));
    assert.equal(queue.stats().running, 0);
    // If the slot had leaked, this would hang.
    await queue.run(undefined, async () => undefined);
  });

  it('drops a queued request whose client went away', async () => {
    const queue = new BoundedQueue(1, 5);
    let release!: () => void;
    const running = queue.run(
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const controller = new AbortController();
    const queued = queue.run(controller.signal, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queue.stats().queued, 1);

    const gone = new ClientGoneError();
    controller.abort(gone);
    await assert.rejects(() => queued, (error: unknown) => error === gone);
    // The abandoned seat must not be handed a slot later.
    assert.equal(queue.stats().queued, 0);

    release();
    await running;
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside the window, then refuses', () => {
    const limiter = new RateLimiter(2, 1000);
    assert.equal(limiter.check('1.2.3.4', 0), true);
    assert.equal(limiter.check('1.2.3.4', 10), true);
    assert.equal(limiter.check('1.2.3.4', 20), false);
    // A different source has its own budget.
    assert.equal(limiter.check('5.6.7.8', 20), true);
  });

  it('starts a fresh window once the old one expires', () => {
    const limiter = new RateLimiter(1, 1000);
    assert.equal(limiter.check('1.2.3.4', 0), true);
    assert.equal(limiter.check('1.2.3.4', 500), false);
    assert.equal(limiter.check('1.2.3.4', 1000), true);
  });

  it('reports the whole seconds left in the window, at least 1', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('1.2.3.4', 0);
    assert.equal(limiter.retryAfterSeconds('1.2.3.4', 1_500), 59);
    assert.equal(limiter.retryAfterSeconds('1.2.3.4', 59_999), 1);
  });
});

describe('workspace lifecycle', () => {
  it('cleans up a workspace', async () => {
    const dir = await createWorkspace();
    assert.ok((await fsp.readdir(TEMP_ROOT)).includes(dir.slice(TEMP_ROOT.length + 1)));
    await removeWorkspace(dir);
    assert.equal(await fsp.stat(dir).then(() => true, () => false), false);
  });

  it('sweeps stale workspaces but keeps live ones', async () => {
    const stale = await createWorkspace();
    const fresh = await createWorkspace();
    // Backdate one directory so it looks like a crashed process left it behind.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    await sweepStaleWorkspaces();

    assert.equal(await fsp.stat(stale).then(() => true, () => false), false, 'stale kept');
    assert.equal(await fsp.stat(fresh).then(() => true, () => false), true, 'fresh removed');
    await removeWorkspace(fresh);
  });
});

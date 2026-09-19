/**
 * Unit tests for the parts that are worth pinning down without a subprocess:
 * the concurrency bound, the rate limiter, password detection, and the exact
 * user-facing strings.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before config.ts is imported - see the note in helpers.ts.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-unit-'));

const { BoundedQueue, RateLimiter } = await import('../src/queue.ts');
const { Errors, AppError, ClientGoneError } = await import('../src/errors.ts');
const { buildMinimalDocx, isPasswordProtected, createWorkspace, removeWorkspace, sweepStaleWorkspaces, inputFileNameFor } =
  await import('../src/convert.ts');
const { MAX_UPLOAD_BYTES, TEMP_ROOT, ALLOWED_EXTENSIONS, isAllowedExtension } = await import(
  '../src/config.ts'
);
const {
  buildEncryptedDocxContainer,
  buildEncryptedLegacyDoc,
  buildPlainLegacyDoc,
} = await import('./fixtures.ts');

after(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true });
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
});

describe('error envelope', () => {
  it('carries the exact code, status and verbatim message for every case', () => {
    const cases: Array<[AppError, number, string, string]> = [
      [
        Errors.convertFailed(),
        500,
        'E_CONVERT_FAILED',
        'This document could not be converted. It may be damaged or in a format the converter does not support.',
      ],
      [Errors.timeout(), 504, 'E_TIMEOUT', 'This document took too long to convert.'],
      [Errors.encrypted(), 422, 'E_ENCRYPTED', 'This document is password protected.'],
      [
        Errors.unsupported(),
        415,
        'E_UNSUPPORTED',
        'Only Word documents (.docx, .docm, .doc) can be converted.',
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
    for (const error of Object.values(Errors)) {
      const produced = (error as () => AppError)().toEnvelope().error.message;
      assert.match(produced, /[.!?]$/, `not a sentence: ${produced}`);
      assert.doesNotMatch(produced, /\/|stack|Error:|undefined|null/i, `leaks internals: ${produced}`);
      // No codes in the text: the code is for logs only.
      assert.doesNotMatch(produced, /E_[A-Z_]+/, `mentions a code: ${produced}`);
    }
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

  it('does not claim garbage is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(256, 0x41));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not claim an empty file is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(0));
    assert.equal(await isPasswordProtected(path), false);
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

describe('config', () => {
  it('caps uploads at the 25MB the client also enforces', () => {
    assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  });

  it('accepts exactly the three Word extensions', () => {
    assert.deepEqual([...ALLOWED_EXTENSIONS].sort(), ['.doc', '.docm', '.docx']);
    assert.equal(isAllowedExtension('.docx'), true);
    assert.equal(isAllowedExtension('.DOCX'), false, 'callers must lower-case first');
    assert.equal(isAllowedExtension('.pdf'), false);
    assert.equal(isAllowedExtension(''), false);
    // Prototype keys must not fool the allowlist check.
    assert.equal(isAllowedExtension('constructor'), false);
  });

  it('names the on-disk upload from the validated extension only', () => {
    assert.equal(inputFileNameFor('.docx'), 'input.docx');
    assert.equal(inputFileNameFor('.doc'), 'input.doc');
  });
});

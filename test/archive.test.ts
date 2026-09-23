/**
 * Unit tests for `validateEntries` - the pre-extraction safety checks
 * `archive.engine.ts` runs against `7z l -slt`'s own listing before any
 * byte is written to disk. Tested directly with hand-built entry lists
 * (the same shape `tables.test.ts` tests `readZipEntry`'s bomb defence
 * with) rather than real multi-hundred-megabyte archives, because the
 * thing under test is arithmetic against a declared count/size - a real
 * archive that large would make the test slow without proving anything a
 * synthetic one does not.
 *
 * The end-to-end behaviour (7z's own subprocess actually refusing a
 * dangerous symlink, a real zip-slip attempt landing safely inside the
 * extraction directory) is covered by the real-file tests in
 * `integration.test.ts`'s "archive engine" section instead - this file is
 * only the arithmetic this service adds on top of that.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-archive-unit-'));

const { validateEntries } = await import('../src/engines/archive.engine.ts');
const { AppError } = await import('../src/errors.ts');
const { MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_UNCOMPRESSED_BYTES } = await import('../src/config.ts');

function file(path: string, size = 10, attributes = ' -rw-r--r--'): {
  path: string;
  isFolder: boolean;
  size: number;
  attributes: string;
  encrypted: boolean;
} {
  return { path, isFolder: false, size, attributes, encrypted: false };
}

describe('validateEntries', () => {
  it('accepts an ordinary small archive', () => {
    assert.doesNotThrow(() => validateEntries([file('a.txt'), file('sub/b.txt')]));
  });

  it('refuses an archive with more entries than the cap', () => {
    const entries = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => file(`f${i}.txt`, 1));
    assert.throws(() => validateEntries(entries), AppError);
  });

  it('accepts exactly the cap', () => {
    const entries = Array.from({ length: MAX_ARCHIVE_ENTRIES }, (_, i) => file(`f${i}.txt`, 1));
    assert.doesNotThrow(() => validateEntries(entries));
  });

  it('refuses an archive whose declared total size is over the ceiling', () => {
    assert.throws(
      () => validateEntries([file('bomb.bin', MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1)]),
      AppError,
    );
  });

  it('does not count folder entries toward the size total', () => {
    // A folder entry's declared "size" is not content - see `7z l -slt`'s
    // own output (`Folder = +`, `Size = 0`) - so a hostile folder entry
    // claiming a huge size should not be able to trip the bomb check.
    assert.doesNotThrow(() =>
      validateEntries([{ ...file('big/', MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1), isFolder: true }]),
    );
  });

  it('refuses a path that escapes with ..', () => {
    assert.throws(() => validateEntries([file('../../etc/passwd')]), AppError);
  });

  it('refuses a path with a .. segment in the middle', () => {
    assert.throws(() => validateEntries([file('a/../../b')]), AppError);
  });

  it('refuses an absolute path', () => {
    assert.throws(() => validateEntries([file('/etc/passwd')]), AppError);
  });

  it('refuses a backslash-style traversal too', () => {
    assert.throws(() => validateEntries([file('..\\..\\windows\\system32')]), AppError);
  });

  it('refuses any symlink entry, not just ones that look dangerous', () => {
    assert.throws(() => validateEntries([file('link', 4, ' lrwxrwxrwx')]), AppError);
  });

  it('refuses an encrypted entry', () => {
    assert.throws(
      () => validateEntries([{ ...file('secret.txt'), encrypted: true }]),
      AppError,
    );
  });

  it('a plain directory entry is not mistaken for a symlink', () => {
    assert.doesNotThrow(() =>
      validateEntries([{ ...file('sub'), isFolder: true, attributes: 'D drwxr-xr-x' }]),
    );
  });
});

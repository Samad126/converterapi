/**
 * The deadline path, which can only be exercised honestly in its own process:
 * CONVERT_TIMEOUT_MS is fixed when config.ts is imported.
 *
 * The point of the deadline is that it is SHORTER than the client's own 120s
 * abort, so the server still gets to answer with a real error instead of being
 * killed mid-conversion and leaving the phone to report a network failure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const childPath = fileURLToPath(new URL('./timeout-child.ts', import.meta.url));

describe('conversion deadline', () => {
  it('answers 504 E_TIMEOUT instead of being killed by the client', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', childPath],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );

    const result = JSON.parse(stdout.trim().split('\n').pop()!) as {
      status: number;
      contentType: string;
      body: string;
      elapsedMs: number;
      leftoverWorkspaces: number;
    };

    assert.equal(result.status, 504);
    assert.match(result.contentType, /application\/json/);

    const envelope = JSON.parse(result.body) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'E_TIMEOUT');
    assert.equal(envelope.error.message, 'This document took too long to convert.');

    // Well inside the client's 120s abort, which is the whole design constraint.
    assert.ok(result.elapsedMs < 90_000, `took ${result.elapsedMs}ms`);

    // The killed conversion must not leave its input, profile or output behind.
    assert.equal(result.leftoverWorkspaces, 0);
  });
});

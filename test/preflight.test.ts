/**
 * The boot refusal.
 *
 * This is the check that has to exist because both of the things it looks for
 * fail SILENTLY. A missing soffice gives you a service that returns 500s, and
 * missing fonts give you something far worse: a service that returns 200 with a
 * PDF whose pagination quietly disagrees with Word. Neither produces an error
 * anyone would notice, so both have to stop the process at startup.
 *
 * Tested by spawning the real entry point with a broken environment, which is
 * the only honest way to test "refuses to boot".
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../src/server.ts', import.meta.url));

interface Boot {
  code: number;
  stdout: string;
  stderr: string;
}

/** Start the server and let it exit on its own, or kill it if it does not. */
async function boot(env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Boot> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--experimental-strip-types', entrypoint],
      { env: { ...process.env, ...env }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

describe('startup check', () => {
  let emptyPathDir: string;
  let fakeBinDir: string;

  before(async () => {
    // A PATH with nothing on it: `fc-match` becomes unresolvable, which is how
    // the font check is exercised without depending on the host's fonts.
    emptyPathDir = await fsp.mkdtemp(join(tmpdir(), 'empty-path-'));
    fakeBinDir = await fsp.mkdtemp(join(tmpdir(), 'fake-bin-'));
    const fakeSoffice = join(fakeBinDir, 'soffice');
    await fsp.writeFile(fakeSoffice, '#!/bin/sh\necho "LibreOffice 0.0.0 (fake)"\nexit 0\n', {
      mode: 0o755,
    });
    // Each boot check has to be reachable on its own. Every test below stubs
    // the checks that come BEFORE the one it is about, so a failure names the
    // thing under test rather than whichever check happens to run first.
    await fsp.writeFile(
      join(fakeBinDir, 'pdftoppm'),
      '#!/bin/sh\necho "pdftoppm version 0.0.0 (fake)"\nexit 0\n',
      { mode: 0o755 },
    );
  });

  after(async () => {
    await fsp.rm(emptyPathDir, { recursive: true, force: true });
    await fsp.rm(fakeBinDir, { recursive: true, force: true });
  });

  it('refuses to boot when soffice is missing, and says how to fix it', async () => {
    const result = await boot({ SOFFICE_BIN: '/nonexistent/soffice' });

    assert.equal(result.code, 1, 'should exit non-zero');
    // Names the binary it tried, so a wrong SOFFICE_BIN is obvious.
    assert.match(result.stderr, /Cannot run "\/nonexistent\/soffice" \(ENOENT\)/);
    // The message has to be actionable, not merely accurate.
    assert.match(result.stderr, /apt-get install -y libreoffice-writer/);
    assert.match(result.stderr, /Dockerfile/);
    // And nothing should have been served.
    assert.doesNotMatch(result.stdout, /listening/);
  });

  it('refuses to boot when the rasteriser is missing, and says how to fix it', async () => {
    // The PNG/JPG targets need poppler, which LibreOffice does not provide.
    // Without this check a container built with only LibreOffice starts happily
    // and fails the first image request instead.
    const result = await boot({
      SOFFICE_BIN: join(fakeBinDir, 'soffice'),
      PDFTOPPM_BIN: '/nonexistent/pdftoppm',
    });

    assert.equal(result.code, 1, 'should exit non-zero');
    assert.match(result.stderr, /Cannot run "\/nonexistent\/pdftoppm" \(ENOENT\)/);
    assert.match(result.stderr, /apt-get install -y poppler-utils/);
    assert.doesNotMatch(result.stdout, /listening/);
  });

  it('refuses to boot when the fonts cannot be verified', async () => {
    // An empty PATH makes `fc-match` unresolvable, which is how the font check
    // is exercised without depending on the host's fonts. soffice and pdftoppm
    // are stubbed so that the two checks before it pass and this one is what
    // fails.
    const result = await boot({
      SOFFICE_BIN: join(fakeBinDir, 'soffice'),
      PDFTOPPM_BIN: join(fakeBinDir, 'pdftoppm'),
      PATH: emptyPathDir,
    });

    assert.equal(result.code, 1, 'should exit non-zero');
    assert.match(result.stderr, /fc-match/);
    assert.match(result.stderr, /fonts/);
    assert.doesNotMatch(result.stdout, /listening/);
  });

  it('refuses to boot when the fonts are missing, naming the packages', async () => {
    // This one depends on the host's fonts, so it only runs where the check
    // actually fires - which is the interesting case anyway, and the exact
    // situation a developer hitting this for the first time is in.
    const { execFileSync } = await import('node:child_process');
    const resolved = execFileSync('fc-match', ['-f', '%{family}', 'Calibri'], {
      encoding: 'utf8',
    }).trim();

    const result = await boot({ SOFFICE_BIN: join(fakeBinDir, 'soffice') });

    if (resolved.split(',').map((f) => f.trim()).includes('Carlito')) {
      // Fonts present: the run should get past preflight and fail later, or be
      // killed by the timeout - either way, not with a font complaint.
      assert.doesNotMatch(result.stderr, /metric-compatible font set/);
      return;
    }

    assert.equal(result.code, 1);
    assert.match(result.stderr, /metric-compatible font set is not installed/);
    assert.match(result.stderr, /fonts-crosextra-carlito/);
    // The reason has to be spelled out: it fails silently otherwise, so the
    // person reading this message is the only thing standing between a missing
    // package and silently wrong pagination.
    assert.match(result.stderr, /paginates differently/);
  });
});

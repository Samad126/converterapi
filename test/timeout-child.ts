/**
 * Runs one conversion with a deliberately tiny deadline and reports the HTTP
 * result as JSON on stdout.
 *
 * This runs in its own process because CONVERT_TIMEOUT_MS is read from the
 * environment when config.ts is first imported, and the test runner has
 * already imported it. Spawning is also the honest way to test a timeout: the
 * deadline really does have to fire against a real soffice process.
 */
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONVERT_TIMEOUT_MS = '1500';
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-timeout-'));

const { createApp } = await import('../src/app.ts');
const { buildMinimalDocx } = await import('../src/lib/probe-documents.ts');
const { BoundedQueue, RateLimiter } = await import('../src/lib/queue.ts');

// ~2.5s of real work against a 1.5s deadline.
const LARGE_DOCX = buildMinimalDocx(
  Array.from(
    { length: 8000 },
    (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again.`,
  ),
);

const app = createApp({
  queue: new BoundedQueue(2, 4),
  rateLimiter: new RateLimiter(100, 60_000),
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

const form = new FormData();
form.append('file', new Blob([LARGE_DOCX]), 'large.docx');

const startedAt = Date.now();
const response = await fetch(`http://127.0.0.1:${port}/convert/pdf`, { method: 'POST', body: form });
const body = await response.text();

let leftover: string[] = [];
try {
  leftover = await fsp.readdir(process.env.TEMP_ROOT);
} catch {
  leftover = [];
}

process.stdout.write(
  `${JSON.stringify({
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
    elapsedMs: Date.now() - startedAt,
    leftoverWorkspaces: leftover.length,
  })}\n`,
);

server.close();
process.exit(0);

/**
 * Test harness.
 *
 * The app is created through `createApp()` rather than `startServer()`, which
 * deliberately skips preflight: the preflight checks are about whether this
 * machine can produce CORRECT pagination, and the tests below are about the
 * HTTP contract, which holds either way.
 */
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

// TEMP_ROOT is read when config.ts is first imported, so it has to be set
// before the dynamic import below - a static import would be hoisted above it
// and the tests would scribble in the real temp root.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-test-'));

const { createApp } = await import('../src/server.ts');
const { BoundedQueue, RateLimiter } = await import('../src/queue.ts');

export const TEMP_ROOT = process.env.TEMP_ROOT;

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  // Generous limits by default so the shared-instance tests do not trip over
  // each other; the tests that care about limits build their own server.
  const app = createApp({
    queue: new BoundedQueue(4, 64),
    rateLimiter: new RateLimiter(1000, 60_000),
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RawResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

export async function upload(
  baseUrl: string,
  filename: string,
  bytes: Buffer,
  options: { mimeType?: string; fieldName?: string } = {},
): Promise<RawResponse> {
  const form = new FormData();
  form.append(
    options.fieldName ?? 'file',
    new Blob([bytes], { type: options.mimeType ?? 'application/octet-stream' }),
    filename,
  );
  const response = await fetch(`${baseUrl}/convert`, { method: 'POST', body: form });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

export function expectJsonEnvelope(
  response: RawResponse,
  expectedStatus: number,
  expectedCode: string,
): { code: string; message: string } {
  if (response.status !== expectedStatus) {
    throw new Error(
      `expected HTTP ${expectedStatus}, got ${response.status}: ${response.body.toString('utf8').slice(0, 300)}`,
    );
  }
  // The client refuses anything that is not JSON here, and falls back to a bare
  // "HTTP <status>" when it cannot parse the body - so a stray HTML error page
  // is a client-visible failure, not a cosmetic one.
  if (!response.contentType?.includes('application/json')) {
    throw new Error(`expected application/json, got ${response.contentType}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new Error(`body is not JSON: ${response.body.toString('utf8').slice(0, 300)}`);
  }
  const envelope = parsed as { error?: { code?: string; message?: string } };
  if (!envelope.error?.code || !envelope.error.message) {
    throw new Error(`body is not the error envelope: ${JSON.stringify(parsed)}`);
  }
  if (envelope.error.code !== expectedCode) {
    throw new Error(`expected code ${expectedCode}, got ${envelope.error.code}`);
  }
  // The message is shown verbatim in a dialog, so it has to read as a sentence
  // for a person - not a stack trace, not a path, not a bare code.
  if (!/[.!?]$/.test(envelope.error.message)) {
    throw new Error(`message is not a sentence: ${JSON.stringify(envelope.error.message)}`);
  }
  return envelope.error as { code: string; message: string };
}

export async function listWorkspaces(): Promise<string[]> {
  try {
    return await fsp.readdir(TEMP_ROOT);
  } catch {
    return [];
  }
}

/** Wait for a condition, up to a deadline. Used for asynchronous cleanup. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

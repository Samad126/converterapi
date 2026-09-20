/**
 * Test harness.
 *
 * The app is created through `createApp()` rather than `startServer()`, which
 * deliberately skips preflight: the preflight checks are about whether this
 * machine can produce CORRECT output, and the tests below are about the HTTP
 * contract, which holds either way.
 */
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';

// TEMP_ROOT is read when config.ts is first imported, so it has to be set
// before the dynamic import below - a static import would be hoisted above it
// and the tests would scribble in the real temp root.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-test-'));

const { createApp } = await import('../src/app.ts');
const { BoundedQueue, RateLimiter } = await import('../src/lib/queue.ts');

export const TEMP_ROOT = process.env.TEMP_ROOT;

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(
  options: { enableDocs?: boolean; corsOrigin?: string } = {},
): Promise<TestServer> {
  // Generous limits by default so the shared-instance tests do not trip over
  // each other; the tests that care about limits build their own server.
  const app = createApp({
    queue: new BoundedQueue(4, 64),
    rateLimiter: new RateLimiter(1000, 60_000),
    enableDocs: options.enableDocs,
    // Off unless a test asks for it, so the rest of the suite sees the same
    // configuration the Android client does - no CORS headers at all.
    corsOrigin: options.corsOrigin ?? '',
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
  /** The filename offer, which mirrors the uploaded name. */
  contentDisposition: string | null;
  body: Buffer;
}

/**
 * POST an upload to /convert/<target>.
 *
 * `target` defaults to `pdf`, which is the conversion the shipped Android
 * client asks for - it is a parameter here because most tests care about the
 * source, not the target, and spelling out `/convert/pdf` in forty places would
 * add noise without adding meaning.
 */
export async function upload(
  baseUrl: string,
  filename: string,
  bytes: Buffer,
  options: {
    mimeType?: string;
    fieldName?: string;
    target?: string;
    /** Extra multipart text fields - `ocr` on `/convert/docx`, for instance. */
    fields?: Record<string, string>;
  } = {},
): Promise<RawResponse> {
  const form = new FormData();
  form.append(
    options.fieldName ?? 'files',
    new Blob([bytes], { type: options.mimeType ?? 'application/octet-stream' }),
    filename,
  );
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    form.append(key, value);
  }
  const path = `/convert/${options.target ?? 'pdf'}`;
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * POST to one of the page endpoints (`/pdf/merge` and friends), which take
 * more than one file, a differently-named field, or extra text fields that
 * `upload()` above has no way to express.
 */
export async function postPages(
  baseUrl: string,
  path: string,
  files: Array<{ filename: string; bytes: Buffer; fieldName?: string; mimeType?: string }>,
  fields: Record<string, string> = {},
): Promise<RawResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append(
      file.fieldName ?? 'files',
      new Blob([file.bytes], { type: file.mimeType ?? 'application/octet-stream' }),
      file.filename,
    );
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
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

/**
 * A real .pptx, produced once per test run by converting an ODP with soffice.
 *
 * This exists to exercise the **.pptx source**: it has its own import filter,
 * so "a deck converts" cannot be concluded from the .odp tests. (The raster
 * pipeline itself is covered with the hand-built ODP, so it does not depend on
 * this generation step.)
 *
 * Hand-writing a minimal PPTX is not the answer: the format needs a theme, a
 * slide master and a slide layout wired together with relationship parts, and a
 * package missing one of them is a file LibreOffice may accept here and reject
 * there - which would make this fixture test the fixture rather than the
 * service. So it is generated with the same engine the service uses, from the
 * ODP probe that IS hand-built and verified. That makes it the one fixture in
 * the suite that depends on a working soffice, which the file already requires.
 */
// Keyed by the slide list: a cache keyed by nothing would hand the two-slide
// deck to a test that asked for one slide, and that test would then pass or
// fail for reasons that have nothing to do with the service.
const pptxCache = new Map<string, Buffer>();

export async function buildPptxFixture(slides: readonly string[]): Promise<Buffer> {
  const cacheKey = JSON.stringify(slides);
  const cached = pptxCache.get(cacheKey);
  if (cached) return cached;

  const { buildMinimalOdp } = await import('../src/lib/probe-documents.ts');
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-pptx-'));
  try {
    const source = join(dir, 'probe.odp');
    await fsp.writeFile(source, buildMinimalOdp(slides));
    await new Promise<void>((resolve, reject) => {
      execFile(
        'soffice',
        [
          '--headless',
          '--norestore',
          '--invisible',
          '--nolockcheck',
          '--nodefault',
          '--nofirststartwizard',
          `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`,
          '--convert-to',
          'pptx:Impress MS PowerPoint 2007 XML',
          '--outdir',
          dir,
          source,
        ],
        { timeout: 120_000, env: { ...process.env, HOME: dir, TMPDIR: dir } },
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const produced = await fsp.readFile(join(dir, 'probe.pptx'));
    pptxCache.set(cacheKey, produced);
    return produced;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read the entry names out of a ZIP, via its central directory.
 *
 * The raster targets answer with an archive, and "did we get one image per
 * slide, named and ordered correctly" is the whole promise being made - so the
 * tests have to look inside rather than trust the content type.
 */
export function zipEntryNames(archive: Buffer): string[] {
  // Locate the end-of-central-directory record by scanning backwards; it is
  // last, but a comment field could in principle follow it.
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record');

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`central directory entry ${i} has the wrong signature`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

/**
 * The text of one page of a PDF, via `pdftotext` (poppler-utils - already a
 * required system dependency, see the rasteriser).
 *
 * This is how the page endpoint tests verify ORDER rather than just page
 * COUNT: pdf-lib, which builds the responses, has no text-extraction API of
 * its own, and a page count alone cannot tell a correctly reordered document
 * from one that merely has the right number of pages.
 */
/**
 * A real JPEG, rendered once per test run from the hand-built PDF probe via
 * `pdftoppm` - there is no pure-JS JPEG encoder in this codebase, and writing
 * one just to have a JPEG fixture would test the fixture, not the service.
 */
let jpegFixtureCache: Promise<Buffer> | undefined;

export function buildJpegFixture(): Promise<Buffer> {
  if (!jpegFixtureCache) {
    jpegFixtureCache = (async () => {
      const { pdfProbe } = await import('../src/lib/probe-documents.ts');
      const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-jpeg-'));
      try {
        const source = join(dir, 'probe.pdf');
        await fsp.writeFile(source, pdfProbe());
        await new Promise<void>((resolve, reject) => {
          execFile(
            'pdftoppm',
            ['-jpeg', '-f', '1', '-l', '1', '-r', '36', source, join(dir, 'page')],
            { timeout: 30_000 },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        return await fsp.readFile(join(dir, 'page-1.jpg'));
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  }
  return jpegFixtureCache;
}

export function pdfPageText(pdf: Buffer, pageNumber: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'pdftotext',
      ['-f', String(pageNumber), '-l', String(pageNumber), '-', '-'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.toString('utf8').trim())),
    );
    child.stdin?.end(pdf);
  });
}

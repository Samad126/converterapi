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

/** POST an upload to /media/<target> - the async job endpoint. Returns the parsed 202 body (or whatever error came back). */
export async function uploadMedia(
  baseUrl: string,
  filename: string,
  bytes: Buffer,
  target: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const response = await fetch(`${baseUrl}/media/${target}`, { method: 'POST', body: form });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

/** GET /media/jobs/<id>. */
export async function getMediaJobStatus(
  baseUrl: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/media/jobs/${id}`);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

/** Poll GET /media/jobs/<id> until it is no longer queued/running, or the timeout elapses. */
export async function pollMediaJob(
  baseUrl: string,
  id: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getMediaJobStatus(baseUrl, id);
    if (body.status !== 'queued' && body.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** GET /media/jobs/<id>/download, as a raw response. */
export async function downloadMediaJob(baseUrl: string, id: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}/media/jobs/${id}/download`);
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
 * A real fixture in a legacy/variant Office extension, produced once per test
 * run by running the same `soffice --convert-to` this service itself runs.
 *
 * Phase 1's new extensions (`.ppt`, `.dot`, `.xls`, `.odg`, and their
 * siblings) are old or rarely-hand-built container formats - there is no
 * sane way to hand-write a minimal one the way `buildMinimalOdp`/
 * `buildMinimalDocx` do for their formats. Generating them with soffice from
 * an already-verified probe is the same trade `buildPptxFixture` makes, for
 * the same reason: it is the one fixture in the suite that depends on a
 * working soffice, which every test here already requires.
 */
const legacyFixtureCache = new Map<string, Buffer>();

export async function buildLegacyFixture(
  sourceBytes: Buffer,
  sourceExtension: string,
  targetExtension: string,
  filter: string,
): Promise<Buffer> {
  const cacheKey = `${sourceExtension}|${targetExtension}|${filter}|${sourceBytes.length}`;
  const cached = legacyFixtureCache.get(cacheKey);
  if (cached) return cached;

  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-legacy-'));
  try {
    const source = join(dir, `probe${sourceExtension}`);
    await fsp.writeFile(source, sourceBytes);
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
          `${targetExtension.slice(1)}:${filter}`,
          '--outdir',
          dir,
          source,
        ],
        { timeout: 120_000, env: { ...process.env, HOME: dir, TMPDIR: dir } },
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const produced = await fsp.readFile(join(dir, `probe${targetExtension}`));
    legacyFixtureCache.set(cacheKey, produced);
    return produced;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run a tool to completion in `cwd`, throwing on a non-zero exit. */
async function runTool(bin: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 60_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(`${bin} ${args.join(' ')} failed: ${error.message}\n${stderr}`)) : resolve(),
    );
  });
}

/**
 * A real, ordinary `.zip`/`.tar`/`.7z` fixture - built with `7z`/`tar`
 * themselves, the same real-tool-not-hand-rolled-bytes trade
 * `buildPptxFixture`/`buildLegacyFixture` already make, for the same reason:
 * these are container formats with real structure, and a fixture that is not
 * itself real proves nothing about whether the service reads real ones.
 */
export async function buildArchiveFixture(
  format: 'zip' | 'tar' | '7z',
  files: Record<string, string>,
): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-archive-'));
  try {
    const srcDir = join(dir, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const full = join(srcDir, name);
      await fsp.mkdir(join(full, '..'), { recursive: true });
      await fsp.writeFile(full, content);
    }
    const outPath = join(dir, `out.${format}`);
    const typeFlag = format === 'zip' ? '-tzip' : format === 'tar' ? '-ttar' : '-t7z';
    await runTool('7z', ['a', typeFlag, outPath, `${srcDir}/.`], dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A real image in another format, built with `ffmpeg` itself from an
 * already-real PNG - the same trade `buildPptxFixture` makes for `.pptx`:
 * hand-rolling a real `.webp`/`.avif`/`.tiff` encoder is not a reasonable
 * ask for a test fixture, so the fixture is generated with the actual
 * engine the service uses, from a source (`buildSolidPng`) that is not.
 */
export async function buildImageFixture(
  pngBytes: Buffer,
  format: 'bmp' | 'gif' | 'tiff' | 'webp' | 'avif' | 'ico' | 'jpg',
): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-image-'));
  try {
    const srcPath = join(dir, 'in.png');
    await fsp.writeFile(srcPath, pngBytes);
    const outPath = join(dir, `out.${format}`);
    await runTool('ffmpeg', ['-y', '-i', srcPath, '-frames:v', '1', '-update', '1', outPath], dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A real, short audio or video file, synthesised entirely by `ffmpeg`'s own
 * `lavfi` test sources (`sine`, `testsrc`) - no external fixture needed at
 * all, and no ambiguity about codec support, since the generator and the
 * thing under test are the same binary.
 */
export async function buildMediaFixture(
  kind: 'audio' | 'video',
  format: string,
): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-media-'));
  try {
    const outPath = join(dir, `out.${format}`);
    const args =
      kind === 'audio'
        ? ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', outPath]
        : [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=160x120:rate=5:duration=1',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=1',
            '-shortest',
            outPath,
          ];
    await runTool('ffmpeg', args, dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A real ISO 9660 image, built with `genisoimage`. */
export async function buildIsoFixture(files: Record<string, string>): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-iso-'));
  try {
    const srcDir = join(dir, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fsp.writeFile(join(srcDir, name), content);
    }
    const outPath = join(dir, 'out.iso');
    await runTool('genisoimage', ['-quiet', '-r', '-o', outPath, srcDir], dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A password-protected `.zip`, built with `7z`.
 *
 * For the "an encrypted archive is refused, not silently skipped" test -
 * `archive.engine.ts`'s own `validateEntries` refuses the whole conversion
 * the moment `7z l -slt` reports `Encrypted = +` on any entry.
 */
export async function buildEncryptedZipFixture(password: string): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-enczip-'));
  try {
    const filePath = join(dir, 'secret.txt');
    await fsp.writeFile(filePath, 'top secret');
    const outPath = join(dir, 'out.zip');
    await runTool('7z', ['a', `-p${password}`, '-mem=AES256', outPath, filePath], dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Malicious archives, built with Python's standard `zipfile` module rather
 * than this project's own `zip.ts` - `zip.ts`'s `safeEntryName` would
 * sanitise away the exact hostile names these fixtures need to exist for the
 * test to mean anything, so a genuinely untrusted-in-the-wild zip writer is
 * the right tool here, the same way `soffice` is the right tool for a
 * fixture that needs to be a real `.ppt`.
 */
async function buildViaPython(script: string): Promise<Buffer> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-malzip-'));
  try {
    const outPath = join(dir, 'out.zip');
    await runTool('python3', ['-c', script.replace('{{OUT}}', outPath)], dir);
    return await fsp.readFile(outPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A zip entry named to escape the extraction directory via `../..`. */
export function buildZipSlipFixture(): Promise<Buffer> {
  return buildViaPython(`
import zipfile
with zipfile.ZipFile('{{OUT}}', 'w') as z:
    z.writestr('normal.txt', 'hello')
    z.writestr('../../../../tmp/converter-archive-slip-canary/pwned.txt', 'evil traversal')
`);
}

/** A zip entry that is a symlink pointing outside the archive. */
export function buildSymlinkEscapeFixture(): Promise<Buffer> {
  return buildViaPython(`
import zipfile, stat
zi = zipfile.ZipInfo('evil_link')
zi.create_system = 3
zi.external_attr = (stat.S_IFLNK | 0o777) << 16
with zipfile.ZipFile('{{OUT}}', 'w') as z:
    z.writestr(zi, '/etc/passwd')
`);
}

/** A zip with more entries than `MAX_ARCHIVE_ENTRIES` should allow. */
export function buildEntryCountBombFixture(count: number): Promise<Buffer> {
  return buildViaPython(`
import zipfile
with zipfile.ZipFile('{{OUT}}', 'w') as z:
    for i in range(${count}):
        z.writestr(f'f{i}.txt', '')
`);
}

/**
 * A single entry whose declared uncompressed size is far over
 * `MAX_ARCHIVE_UNCOMPRESSED_BYTES`, backed by real (highly compressible)
 * bytes rather than a hand-patched lie - so the fixture is small on disk
 * while the declared size the central directory reports is genuinely huge,
 * exactly what `7z l -slt` (and any real decompression bomb) looks like.
 */
export function buildDeclaredSizeBombFixture(declaredBytes: number): Promise<Buffer> {
  return buildViaPython(`
import zipfile
with zipfile.ZipFile('{{OUT}}', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('bomb.bin', b'0' * ${declaredBytes})
`);
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
 * The entry names in a `.tar`, via the real `tar` binary - reading the
 * format ourselves is not worth a second implementation when the system
 * `tar` is already a dependency this test suite can assume, the same way
 * `pdftotext` below is assumed for reading a PDF's text.
 */
export async function tarEntryNames(archive: Buffer): Promise<string[]> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-tarread-'));
  try {
    const path = join(dir, 'in.tar');
    await fsp.writeFile(path, archive);
    const output = await new Promise<string>((resolve, reject) => {
      execFile('tar', ['-tf', path], { cwd: dir }, (error, stdout, stderr) =>
        error ? reject(new Error(`tar -tf failed: ${error.message}\n${stderr}`)) : resolve(stdout),
      );
    });
    return output.split('\n').filter((line) => line.trim() !== '');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Does a real `.tar.gz` contain a given file, via the real `tar` binary? */
export async function tarGzContainsFile(archive: Buffer, name: string): Promise<boolean> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'converter-targzread-'));
  try {
    const path = join(dir, 'in.tar.gz');
    await fsp.writeFile(path, archive);
    const output = await new Promise<string>((resolve, reject) => {
      execFile('tar', ['-tzf', path], { cwd: dir }, (error, stdout, stderr) =>
        error ? reject(new Error(`tar -tzf failed: ${error.message}\n${stderr}`)) : resolve(stdout),
      );
    });
    return output.split('\n').some((line) => line.trim() === name);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

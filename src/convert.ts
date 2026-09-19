/**
 * The LibreOffice invocation, and everything around it.
 *
 * Two things about running soffice as a service are easy to get wrong, and both
 * fail intermittently rather than loudly:
 *
 *  1. Every invocation needs its OWN user profile
 *     (`-env:UserInstallation=file:///<tmp>/lo-profile`). Without it, concurrent
 *     soffice processes collide over the shared profile directory and
 *     conversions fail or hang at random. This is the single most common cause
 *     of "works on my machine" in a service like this.
 *
 *  2. The metric-compatible fonts must be installed (see config.ts and the
 *     README). Without them LibreOffice substitutes a font with different
 *     metrics for Calibri and Cambria, and every line breaks in a different
 *     place. The document converts, the PDF looks right, and the pagination
 *     quietly disagrees with Word.
 *
 * Both are checked at boot by `preflight()` and both refuse to start the
 * service, because neither one produces an error you would ever notice.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';

import {
  ALLOWED_EXTENSIONS,
  CONVERT_TIMEOUT_MS,
  REQUIRED_FONT_ALIASES,
  SIGKILL_GRACE_MS,
  SOFFICE_BIN,
  STALE_WORKSPACE_MS,
  TEMP_ROOT,
  type AllowedExtension,
} from './config.ts';
import { ClientGoneError, Errors, PreflightError } from './errors.ts';

/** Name we give the upload on disk. Server-generated, never the client's. */
const INPUT_BASENAME = 'input';
const OUTPUT_DIRNAME = 'out';
const PROFILE_DIRNAME = 'lo-profile';

/** Best-effort encryption sniffing gives up past this; soffice decides instead. */
const DETECTION_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Per-request workspaces
// ---------------------------------------------------------------------------

/**
 * Create the isolated temp dir that holds one request's input, LibreOffice
 * profile and output.
 *
 * Everything for a request lives under one directory so that cleanup is a
 * single recursive delete, and so a crash can be swept up later by looking at
 * mtimes (see `sweepStaleWorkspaces`).
 */
export async function createWorkspace(): Promise<string> {
  await fsp.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(join(TEMP_ROOT, 'req-'));
}

/** Idempotent: safe to call from a finally block and from a close handler. */
export async function removeWorkspace(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Delete workspaces left behind by a crashed or killed process.
 *
 * Only directories older than STALE_WORKSPACE_MS are touched, which is why that
 * value must stay comfortably above CONVERT_TIMEOUT_MS: a live conversion's
 * workspace is never old enough to be swept.
 */
export async function sweepStaleWorkspaces(now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(TEMP_ROOT);
  } catch {
    return 0; // Root does not exist yet; nothing to sweep.
  }

  for (const entry of entries) {
    const full = join(TEMP_ROOT, entry);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs < STALE_WORKSPACE_MS) continue;
      // Re-check mtime right before deleting: a workspace that was touched
      // between the stat and the delete belongs to something still alive.
      const fresh = await fsp.stat(full);
      if (now - fresh.mtimeMs < STALE_WORKSPACE_MS) continue;
      await removeWorkspace(full);
      removed += 1;
    } catch {
      // Racing another sweep, or already gone. Either way, nothing to do.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Per-request temp dir from `createWorkspace()`. */
  workspace: string;
  /** Validated extension of the uploaded part; selects the import filter. */
  extension: AllowedExtension;
  /** Aborted when the client disconnects, so we can kill a running soffice. */
  signal?: AbortSignal;
}

export interface ConvertResult {
  pdf: Buffer;
  /** Wall-clock duration of the soffice run, for logging. */
  durationMs: number;
}

/**
 * The filename we write the upload to: `<basename>.<validated extension>`.
 *
 * The client's own filename is NEVER used on disk. It is only ever read to
 * derive the extension, because a filename like `../../etc/cron.d/x.docx` is a
 * path traversal waiting to happen and there is no reason to take the risk.
 *
 * The extension is preserved rather than normalised away because that is how
 * soffice chooses the import filter - it is the whole mechanism by which we
 * honour "pick the filter from the extension, not the MIME type".
 */
export function inputFileNameFor(extension: AllowedExtension): string {
  return `${INPUT_BASENAME}${extension}`;
}

export async function convertToPdf(options: ConvertOptions): Promise<ConvertResult> {
  const { workspace, extension, signal } = options;
  const inputPath = join(workspace, inputFileNameFor(extension));
  const outDir = join(workspace, OUTPUT_DIRNAME);
  const profileDir = join(workspace, PROFILE_DIRNAME);

  if (signal?.aborted) throw signal.reason ?? new ClientGoneError();

  // Fail fast, and with a message that actually helps, when the document is
  // password protected. Left to itself soffice reports this the same way it
  // reports a corrupt file, which would tell the user their document is
  // damaged when in fact it just needs a password.
  if (await isPasswordProtected(inputPath)) {
    throw Errors.encrypted();
  }

  await fsp.mkdir(outDir, { recursive: true });

  const startedAt = Date.now();
  const outcome = await runSoffice({
    inputPath,
    outDir,
    profileDir,
    workspace,
    signal,
  });
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') throw new ClientGoneError();

  // --convert-to exits 0 even when it produced nothing at all, so the exit code
  // carries no information about success. The only trustworthy signal is the
  // file itself. (Verified: a corrupt .docx gives
  // "Error: source file could not be loaded" and exit status 0.)
  const pdf = await readProducedPdf(outDir);
  if (!pdf) {
    throw Errors.convertFailed(
      `soffice exit=${outcome.exitCode} signal=${outcome.signal ?? 'none'} stderr=${outcome.stderr}`,
    );
  }

  return { pdf, durationMs };
}

type SofficeOutcome =
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

function runSoffice(args: {
  inputPath: string;
  outDir: string;
  profileDir: string;
  workspace: string;
  signal?: AbortSignal;
}): Promise<SofficeOutcome> {
  const { inputPath, outDir, profileDir, workspace, signal } = args;

  return new Promise<SofficeOutcome>((resolve) => {
    const child = spawn(
      SOFFICE_BIN,
      [
        '--headless',
        '--norestore',
        '--invisible',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        // Requirement #1: a private profile per invocation. `pathToFileURL`
        // gives us a correctly escaped file:// URL rather than string
        // concatenation, which breaks on paths with spaces or unicode.
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        outDir,
        inputPath,
      ],
      {
        // A new process group, so a timeout can kill soffice AND any helpers it
        // forked. Killing just the direct child can leave a detached helper
        // holding the CPU.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Nothing should write into a real home directory, so point HOME and
          // TMPDIR at this request's workspace.
          HOME: workspace,
          TMPDIR: workspace,
          // Keep output stable regardless of the host's locale, and stop
          // soffice from trying to reach a Java runtime it does not need.
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          SAL_USE_VCLPLUGIN: 'svp',
          JAVA_TOOL_OPTIONS: '',
        },
      },
    );

    let stderr = '';
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: SofficeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    // SIGTERM first so soffice can shut down cleanly, SIGKILL shortly after for
    // the case where it is wedged and will never honour a polite request.
    const terminate = () => {
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };

    function onAbort() {
      terminate();
      finish({ kind: 'aborted' });
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a pathological document can make soffice extremely chatty, and
      // this text exists only to explain a failure in the logs.
      if (stderr.length < 8_192) stderr += chunk.toString('utf8');
    });
    // stdout is not read for content, but the stream has to be drained or a
    // full pipe buffer will block soffice forever.
    child.stdout?.on('data', () => {});

    timeoutTimer = setTimeout(() => {
      terminate();
      finish({ kind: 'timeout' });
    }, CONVERT_TIMEOUT_MS);
    timeoutTimer.unref?.();

    if (signal) {
      if (signal.aborted) {
        terminate();
        finish({ kind: 'aborted' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      // spawn itself failed (ENOENT and friends).
      finish({ kind: 'exited', exitCode: null, signal: null, stderr: String(error) });
    });

    child.on('close', (code, signalName) => {
      finish({ kind: 'exited', exitCode: code, signal: signalName, stderr });
    });
  });
}

/**
 * Signal the whole process group, falling back to the direct child.
 *
 * Negative PID targets the group created by `detached: true`. The fallback
 * matters on platforms without process groups, and for the race where the child
 * has already exited and its PID is no longer a valid group.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead. Nothing to do.
    }
  }
}

/**
 * Find the PDF soffice was supposed to write, and insist that it is not empty.
 *
 * Normally the name is `<basename>.pdf`, but we fall back to any PDF in the
 * output directory so that a change in LibreOffice's naming (or a document that
 * redirects the output) degrades into "still works" rather than "mysteriously
 * fails".
 */
async function readProducedPdf(outDir: string): Promise<Buffer | null> {
  const expected = join(outDir, `${INPUT_BASENAME}.pdf`);
  const candidates = [expected];

  let entries: string[] = [];
  try {
    entries = await fsp.readdir(outDir);
  } catch {
    return null; // --outdir was never created: soffice produced nothing.
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.pdf')) continue;
    const full = join(outDir, entry);
    if (!candidates.includes(full)) candidates.push(full);
  }

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile() || stat.size === 0) continue;
      const buffer = await fsp.readFile(candidate);
      // An empty PDF is a failure, and so is a file that is not a PDF at all.
      if (buffer.length === 0) continue;
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) continue;
      return buffer;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Password-protected detection
// ---------------------------------------------------------------------------

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Does this document need a password?
 *
 * Worth doing ourselves because soffice has no distinct signal for it - an
 * encrypted document and a corrupt one both come back as "could not be loaded",
 * and telling a user their file is damaged when it merely needs a password is
 * both wrong and unhelpful.
 *
 * ECMA-376 encryption wraps the package in an OLE/CFB container holding an
 * `EncryptedPackage` stream, so an encrypted .docx/.docm stops being a zip.
 * Legacy .doc files stay CFB either way and set `fEncrypted` (or `fObfuscated`)
 * in the FIB.
 *
 * Best effort by design: anything we cannot parse confidently returns false and
 * the decision falls through to soffice. A false negative costs a less specific
 * error message; a false positive would reject a document we could have
 * converted, which is much worse.
 */
export async function isPasswordProtected(inputPath: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(inputPath, 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8 || !head.equals(CFB_MAGIC)) {
      // A zip-based package (.docx/.docm) is never encrypted in place, and
      // anything else is not our problem to classify.
      return false;
    }

    const stat = await handle.stat();
    if (stat.size > DETECTION_MAX_BYTES) return false;

    const buffer = await fsp.readFile(inputPath);
    return cfbLooksEncrypted(buffer);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface CfbDirectory {
  streams: Map<string, { startSector: number; size: number }>;
  sectorSize: number;
  miniCutoff: number;
}

function cfbLooksEncrypted(buffer: Buffer): boolean {
  const directory = readCfbDirectory(buffer);
  if (!directory) return false;

  // Agile/Standard encryption: the package is a CFB holding EncryptedPackage.
  if (directory.streams.has('EncryptedPackage')) return true;

  const wordDocument = directory.streams.get('WordDocument');
  if (!wordDocument) return false;
  // Small streams live in the mini-FAT, which we deliberately do not follow -
  // a real WordDocument stream is never that small.
  if (wordDocument.size < directory.miniCutoff) return false;

  const offset = sectorOffset(wordDocument.startSector, directory.sectorSize);
  if (offset + 16 > buffer.length) return false;

  const wIdent = buffer.readUInt16LE(offset);
  if (wIdent !== 0xa5ec) return false; // Not a Word FIB; let soffice judge.

  const fibFlags = buffer.readUInt16LE(offset + 10);
  const fEncrypted = (fibFlags & 0x0100) !== 0;
  const fObfuscated = (fibFlags & 0x8000) !== 0;
  return fEncrypted || fObfuscated;
}

function sectorOffset(sector: number, sectorSize: number): number {
  return (sector + 1) * sectorSize;
}

/**
 * Minimal OLE/CFB directory reader: enough to list stream names and locations.
 *
 * Header field offsets (MS-CFB):
 *   0x1E sector shift (log2 of sector size)
 *   0x2C number of FAT sectors
 *   0x30 first directory sector
 *   0x38 mini stream cutoff
 *   0x4C DIFAT[0..108]
 */
function readCfbDirectory(buffer: Buffer): CfbDirectory | null {
  if (buffer.length < 512) return null;

  const sectorShift = buffer.readUInt16LE(0x1e);
  if (sectorShift < 7 || sectorShift > 20) return null;
  const sectorSize = 1 << sectorShift;
  const miniCutoff = buffer.readUInt32LE(0x38) || 4096;
  const firstDirSector = buffer.readUInt32LE(0x30);

  // Build the FAT from the header's DIFAT. The first 109 entries cover ~7MB of
  // FAT with 512-byte sectors - far more than any document we accept needs -
  // and a file that wants more simply falls through to soffice.
  const fat: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sector = buffer.readUInt32LE(0x4c + i * 4);
    if (sector === 0xffffffff) break;
    const offset = sectorOffset(sector, sectorSize);
    if (offset + sectorSize > buffer.length) break;
    for (let entry = 0; entry < sectorSize / 4; entry += 1) {
      fat.push(buffer.readUInt32LE(offset + entry * 4));
    }
  }
  if (fat.length === 0) return null;

  const streams = new Map<string, { startSector: number; size: number }>();
  const visited = new Set<number>();
  let sector: number = firstDirSector;
  let guard = 0;

  while (sector < fat.length && guard < 4096 && !visited.has(sector)) {
    visited.add(sector);
    guard += 1;
    const offset = sectorOffset(sector, sectorSize);
    if (offset + sectorSize > buffer.length) break;

    for (let entry = 0; entry + 128 <= sectorSize; entry += 128) {
      const base = offset + entry;
      const nameLength = buffer.readUInt16LE(base + 64);
      const objectType = buffer.readUInt8(base + 66);
      // 2 = stream. Storages (1) and the root (5) are not what we are after.
      if (objectType !== 2 || nameLength < 2 || nameLength > 64) continue;
      const name = buffer
        .subarray(base, base + nameLength - 2)
        .toString('utf16le');
      if (!name) continue;
      streams.set(name, {
        startSector: buffer.readUInt32LE(base + 116),
        size: Number(buffer.readBigUInt64LE(base + 120)),
      });
    }
    sector = fat[sector] ?? 0xfffffffe;
  }

  return { streams, sectorSize, miniCutoff };
}

// ---------------------------------------------------------------------------
// Boot-time preflight
// ---------------------------------------------------------------------------

export interface PreflightReport {
  sofficeVersion: string;
  fonts: Array<{ requested: string; resolved: string }>;
}

/**
 * Refuse to boot unless the service can actually do its job.
 *
 * Every condition checked here fails SILENTLY if you skip it: a missing soffice
 * gives you a service that returns 500s, and missing fonts give you something
 * far worse - a service that returns 200 with a PDF whose pagination disagrees
 * with Word. Nobody notices the second one until a customer does.
 */
export async function preflight(): Promise<PreflightReport> {
  assertNotRoot();
  const sofficeVersion = assertSofficePresent();
  const fonts = assertMetricCompatibleFonts();
  return { sofficeVersion, fonts };
}

function assertNotRoot(): void {
  // LibreOffice parses untrusted documents; that parser is the entire attack
  // surface. Running it as uid 0 turns any bug in it into a total compromise of
  // the container, so a uid-0 process is a misconfiguration, not a convenience.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new PreflightError(
      [
        'Refusing to start as root (uid 0).',
        '',
        'This service parses untrusted documents with LibreOffice. Running that',
        'parser as root means any bug in it compromises the whole container.',
        'Run it as an unprivileged user - the provided Dockerfile and',
        'docker-compose.yml already do this.',
      ].join('\n'),
    );
  }
}

function assertSofficePresent(): string {
  const result = spawnSync(SOFFICE_BIN, ['--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: process.env.HOME ?? '/tmp' },
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${SOFFICE_BIN}" (${code ?? result.error.message}).`,
        '',
        'LibreOffice headless is the conversion engine - there is no fallback.',
        '  Debian/Ubuntu:  apt-get install -y libreoffice-writer',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set SOFFICE_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${SOFFICE_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim().split('\n')[0] ?? '';
}

function assertMetricCompatibleFonts(): Array<{ requested: string; resolved: string }> {
  const resolvedFonts: Array<{ requested: string; resolved: string }> = [];
  const missing: Array<{ requested: string; expect: string; pkg: string; got: string }> = [];

  for (const alias of REQUIRED_FONT_ALIASES) {
    const result = spawnSync('fc-match', ['-f', '%{family}', alias.requested], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    if (result.error) {
      throw new PreflightError(
        [
          'Cannot run "fc-match", so the installed fonts cannot be verified.',
          '',
          '  Debian/Ubuntu:  apt-get install -y fontconfig',
          '',
          'This check exists because missing fonts fail silently: LibreOffice',
          'substitutes a font with different metrics and every line breaks in a',
          'different place, so the PDF paginates differently from Word while',
          'still looking perfectly fine.',
        ].join('\n'),
        { cause: result.error },
      );
    }

    const resolved = (result.stdout ?? '').trim();
    // fc-match reports a fallback chain, e.g. "Carlito,Calibri" or
    // "Liberation Sans,Arial". The expected family must appear in it.
    const families = resolved.split(',').map((f) => f.trim());
    if (!families.includes(alias.expect)) {
      missing.push({ ...alias, got: resolved || '(nothing)' });
    } else {
      resolvedFonts.push({ requested: alias.requested, resolved: alias.expect });
    }
  }

  if (missing.length > 0) {
    const packages = [...new Set(missing.map((m) => m.pkg))];
    throw new PreflightError(
      [
        'Refusing to start: the metric-compatible font set is not installed.',
        '',
        ...missing.map((m) => `  ${m.requested.padEnd(16)} resolved to "${m.got}", expected ${m.expect}  (${m.pkg})`),
        '',
        'WHY THIS IS FATAL: Calibri and Cambria do not exist on Linux. Without',
        'these packages LibreOffice substitutes a font with different metrics, so',
        'every line breaks in a different place and the PDF paginates differently',
        'from Word - while still converting successfully and looking correct.',
        'Nothing else in the system would ever report a problem.',
        '',
        'Install them:',
        `  Debian/Ubuntu:  apt-get install -y ${packages.join(' ')}`,
        '  Then refresh the font cache:  fc-cache -f',
        '',
        'The real Microsoft core fonts (ttf-mscorefonts-installer) are NOT the',
        'answer: they need an interactive EULA acceptance, which is exactly the',
        'kind of thing that breaks an unattended image build, and the metric-',
        'compatible set above is a drop-in replacement for the metrics that',
        'pagination actually depends on. See README "Fonts".',
      ].join('\n'),
    );
  }

  return resolvedFonts;
}

/**
 * Convert a tiny built-in document once, at boot.
 *
 * Preflight proves soffice runs and the fonts resolve; it does not prove the
 * two work together to produce a PDF. Warming up does, and it also pays the
 * one-off cost of the first-run profile creation here rather than inside some
 * unlucky user's first request.
 */
export async function warmUp(): Promise<number> {
  const workspace = await createWorkspace();
  try {
    const probe = buildMinimalDocx([
      'Converter warm-up',
      'Calibri Cambria Arial Times New Roman Courier New 0123456789',
    ]);
    await fsp.writeFile(join(workspace, inputFileNameFor('.docx')), probe);
    const { pdf } = await convertToPdf({ workspace, extension: '.docx' });
    return pdf.length;
  } finally {
    await removeWorkspace(workspace);
  }
}

// ---------------------------------------------------------------------------
// A minimal, genuinely valid .docx, used as the warm-up probe and in tests
// ---------------------------------------------------------------------------

/**
 * Build a real OOXML package: a ZIP of the required parts, stored rather than
 * deflated (we do not need compression, and stored entries keep this dependency
 * free and the bytes reproducible).
 *
 * This is a valid .docx - LibreOffice imports it as a Writer document - which
 * makes it useful both as the boot-time probe and as a test fixture that does
 * not need a binary blob checked into the repository.
 */
export function buildMinimalDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map(
      (text) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    )
    .join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return zipStored([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Write a ZIP archive with stored (uncompressed) entries. */
function zipStored(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  // Fixed DOS timestamp (1980-01-01 00:00:00) so the same input always produces
  // byte-identical output - handy when diffing a fixture.
  const dosTime = 0;
  const dosDate = 0x0021;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8); // flags
    header.writeUInt16LE(0, 10); // method: stored
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** Re-exported so tests can assert against the same list the server enforces. */
export { ALLOWED_EXTENSIONS };

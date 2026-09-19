/**
 * Every cross-system constant and tunable lives here.
 *
 * The upload ceiling in particular is a CONTRACT with the Android client: the
 * client has its own MAX_UPLOAD_BYTES and refuses to send more than that, so if
 * the two ever disagree the disagreement shows up as a confusing client-side
 * error rather than a clear server response. Keep them equal.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 * 1024;

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Upload ceiling, in bytes. MUST equal the Android client's MAX_UPLOAD_BYTES.
 * Also mirrored by the reverse proxy's request body limit (see deploy/Caddyfile)
 * so an oversized upload is refused before it reaches Node at all.
 */
export const MAX_UPLOAD_BYTES = 25 * MB;

/**
 * Our own conversion deadline.
 *
 * The client aborts the whole request after 120s. Our deadline has to be
 * comfortably shorter than that, otherwise we get killed mid-conversion and the
 * client shows "HTTP <status>" (or a network error) instead of the sentence we
 * wanted to show.
 */
export const CONVERT_TIMEOUT_MS = intFromEnv('CONVERT_TIMEOUT_MS', 90_000, 1_000);

/** How long a soffice process gets to die on SIGTERM before we SIGKILL it. */
export const SIGKILL_GRACE_MS = intFromEnv('SIGKILL_GRACE_MS', 5_000, 100);

/** soffice handles one document per process and is CPU/memory heavy. */
export const MAX_CONCURRENT_CONVERSIONS = intFromEnv('MAX_CONCURRENT_CONVERSIONS', 2, 1);

/** How many requests may wait for a slot before we start returning 503 E_BUSY. */
export const MAX_QUEUED_CONVERSIONS = intFromEnv('MAX_QUEUED_CONVERSIONS', 8, 0);

/** Root for per-request temp dirs (input + LO profile + output). */
export const TEMP_ROOT = process.env.TEMP_ROOT ?? join(tmpdir(), 'file-converter');

/**
 * A workspace older than this is assumed to belong to a crashed process.
 * Must be comfortably larger than CONVERT_TIMEOUT_MS so a slow-but-alive
 * conversion is never swept out from under itself.
 */
export const STALE_WORKSPACE_MS = intFromEnv('STALE_WORKSPACE_MS', 15 * 60_000, 60_000);

export const SWEEP_INTERVAL_MS = intFromEnv('SWEEP_INTERVAL_MS', 5 * 60_000, 10_000);

export const PORT = intFromEnv('PORT', 3001, 1);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const SOFFICE_BIN = process.env.SOFFICE_BIN ?? 'soffice';

/** Per-IP request budget. Unauthenticated endpoint on the public internet. */
export const RATE_LIMIT_WINDOW_MS = intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000, 1_000);
export const RATE_LIMIT_MAX = intFromEnv('RATE_LIMIT_MAX', 30, 1);

/**
 * Behind a reverse proxy, req.ip is only meaningful if we trust the proxy's
 * forwarding header - otherwise every request shares one rate limit bucket.
 *
 * Accepts what Express accepts: `loopback`, an IP or subnet list, `true`/
 * `false`, or a hop count. The hop count has to be passed as a NUMBER - Express
 * would read the string "1" as the IP address 1, which is not what anyone
 * means by it, and silently gets you the wrong client address.
 */
function trustProxyFromEnv(): string | number | boolean {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 'loopback';
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export const TRUST_PROXY = trustProxyFromEnv();

/** Run the boot-time warm-up conversion? Proves the pipeline end to end. */
export const SKIP_WARMUP = process.env.SKIP_WARMUP === '1';

/**
 * Serve the OpenAPI document and the Swagger UI.
 *
 * On by default: it is a static description of the public contract, contains
 * nothing sensitive, and the client-facing endpoints it documents are already
 * public. Set `ENABLE_DOCS=0` to turn it off.
 */
export const ENABLE_DOCS = process.env.ENABLE_DOCS !== '0';

/**
 * Extensions we accept, and the LibreOffice import filter each one implies.
 *
 * The import filter is chosen from the FILENAME EXTENSION of the uploaded part
 * - never from its declared MIME type, which the client deliberately sends as
 * application/octet-stream and which a hostile client could set to anything.
 *
 * soffice infers the filter from the extension of the file it is handed, which
 * is why we write the upload to disk as `<server-name>.<validated extension>`.
 * The filter names are recorded here so the mapping is auditable in one place.
 */
export const IMPORT_FILTERS = {
  '.docx': 'MS Word 2007 XML',
  '.docm': 'MS Word 2007 XML',
  '.doc': 'MS Word 97',
} as const;

export type AllowedExtension = keyof typeof IMPORT_FILTERS;

export const ALLOWED_EXTENSIONS = Object.keys(IMPORT_FILTERS) as AllowedExtension[];

export function isAllowedExtension(ext: string): ext is AllowedExtension {
  return Object.prototype.hasOwnProperty.call(IMPORT_FILTERS, ext);
}

/**
 * Fonts LibreOffice must be able to resolve to a metric-compatible substitute.
 *
 * Calibri and Cambria (and Arial / Times New Roman / Courier New) are Microsoft
 * fonts that are not present on Linux. Without the metric-compatible set,
 * LibreOffice substitutes a font with different glyph widths and every line
 * breaks in a different place - the document converts, the PDF looks right, and
 * the pagination silently disagrees with Word.
 *
 * `fc-match` resolves the alias chain, so a correct answer here proves BOTH
 * that the font is installed AND that the fontconfig alias exists - which is
 * exactly the pair of conditions that has to hold. See README "Fonts".
 */
export const REQUIRED_FONT_ALIASES: ReadonlyArray<{
  /** The font a Word document asks for. */
  requested: string;
  /** The metric-compatible family it must resolve to. */
  expect: string;
  /** Debian/Ubuntu package that provides it. */
  pkg: string;
}> = [
  { requested: 'Calibri', expect: 'Carlito', pkg: 'fonts-crosextra-carlito' },
  { requested: 'Cambria', expect: 'Caladea', pkg: 'fonts-crosextra-caladea' },
  { requested: 'Arial', expect: 'Liberation Sans', pkg: 'fonts-liberation' },
  { requested: 'Times New Roman', expect: 'Liberation Serif', pkg: 'fonts-liberation' },
  { requested: 'Courier New', expect: 'Liberation Mono', pkg: 'fonts-liberation' },
];

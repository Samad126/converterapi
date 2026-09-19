/**
 * Every cross-system constant and tunable lives here.
 *
 * This file holds what depends on the ENVIRONMENT. The conversion matrix - what
 * we accept, what it can become, and with which LibreOffice filter - lives in
 * `formats.ts`, because that is a description of the product rather than a knob
 * somebody turns on a particular host.
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
 * Also mirrored by the reverse proxy's request body limit (see the API block in
 * deploy/converter.alakbaroff.com.conf) so an oversized upload is refused
 * before it reaches Node at all - which is also why that 413 needs its own CORS
 * header: the application never sees the response.
 */
export const MAX_UPLOAD_BYTES = 25 * MB;

/**
 * Our own conversion deadline.
 *
 * The client aborts the whole request after 120s. Our deadline has to be
 * comfortably shorter than that, otherwise we get killed mid-conversion and the
 * client shows "HTTP <status>" (or a network error) instead of the sentence we
 * wanted to show.
 *
 * The deadline covers the WHOLE pipeline, including the PDF-then-rasterise
 * second step a PNG/JPG request needs, because it is the client's patience it
 * has to stay inside - not soffice's.
 */
export const CONVERT_TIMEOUT_MS = intFromEnv('CONVERT_TIMEOUT_MS', 90_000, 1_000);

/** How long a soffice process gets to die on SIGTERM before we SIGKILL it. */
export const SIGKILL_GRACE_MS = intFromEnv('SIGKILL_GRACE_MS', 5_000, 100);

/** soffice handles one document per process and is CPU/memory heavy. */
export const MAX_CONCURRENT_CONVERSIONS = intFromEnv('MAX_CONCURRENT_CONVERSIONS', 2, 1);

/** How many requests may wait for a slot before we start returning 503 E_BUSY. */
export const MAX_QUEUED_CONVERSIONS = intFromEnv('MAX_QUEUED_CONVERSIONS', 8, 0);

/**
 * Longest basename we will echo back in a Content-Disposition header.
 *
 * The uploaded filename is attacker-controlled, so its length is too. Headers
 * have to be held in memory and logged by every hop, and no real document name
 * is 255 characters of filename on top of the directory it came from.
 */
export const MAX_DOWNLOAD_NAME_LENGTH = intFromEnv('MAX_DOWNLOAD_NAME_LENGTH', 100, 1);

/** Root for per-request temp dirs (input + LO profile + output). */
export const TEMP_ROOT = process.env.TEMP_ROOT ?? join(tmpdir(), 'converterapi');

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

/**
 * Rasteriser for the PNG/JPG targets (Debian package: poppler-utils).
 *
 * A separate binary because LibreOffice cannot do this job: its command-line
 * image export writes only the first page of a presentation, whatever the
 * filter options say. Rendering the PDF is the only way to get one image per
 * slide. See services/conversion.service.ts.
 */
export const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN ?? 'pdftoppm';

/**
 * Resolution of a rasterised page, in DPI.
 *
 * 150 is the point where projected slide text is sharp without the output
 * getting silly: a 16:9 slide lands around 2000x1125, so a 30-slide deck is
 * tens of megabytes rather than hundreds.
 */
export const RASTER_DPI = intFromEnv('RASTER_DPI', 150, 36);

/** JPEG quality for the JPG target. pdftoppm's own default is 75. */
export const RASTER_JPEG_QUALITY = intFromEnv('RASTER_JPEG_QUALITY', 90, 1);

/**
 * How many pages we will rasterise into one archive.
 *
 * The whole archive is built in memory before it is sent, so this is a memory
 * bound rather than a taste judgement: 100 slides at 150 DPI is roughly 30MB of
 * images, times MAX_CONCURRENT_CONVERSIONS. Past the limit the request is
 * refused with E_TOO_LARGE rather than OOM-killing the container mid-response.
 */
export const MAX_RASTER_PAGES = intFromEnv('MAX_RASTER_PAGES', 100, 1);

/**
 * How many grid positions one document may contribute before we refuse.
 *
 * Cells and rows BOTH count one each, because both are retained in memory: a
 * row is an array whether or not anything is in it, so a document of empty
 * rows costs as much as a document of filled ones while contributing no cells
 * at all. Counting only cells let 300,000 of them through as a clean
 * extraction of an empty table.
 *
 * The same reasoning as MAX_RASTER_PAGES, and for the same reason: the
 * workbook is assembled in memory, so this is a memory bound rather than a
 * taste judgement. What makes it necessary here is that the amplification has
 * nothing to do with the upload size - a 138KB document with a 5000x10 table
 * is 50,000 cells, and merges are counted once per column they cover, so
 * `w:gridSpan` makes a document cost more than its own text suggests. A bound
 * on bytes would not catch that; a bound on grid positions does.
 *
 * 200,000 is roughly four tables of that size, which is far past any document
 * a person is converting on a phone.
 */
export const MAX_TABLE_CELLS = intFromEnv('MAX_TABLE_CELLS', 200_000, 1);

/**
 * How many tables one document may hold.
 *
 * This looks redundant next to MAX_TABLE_CELLS and is not: the two bound
 * different things, and a document can be pathological through either. The
 * extractor holds a frame per table while it scans - the tables are only
 * ordered and filtered once the scan is over - so a document consisting of
 * nothing but empty tables costs memory per table and no cells at all.
 *
 * Measured: a 14MB document of one million empty tables grew the heap by
 * 305MB while reporting a perfectly clean extraction of zero tables. That is
 * comfortably inside MAX_DOCUMENT_XML_BYTES and comfortably outside what a
 * 1GB container can serve twice at once, which is exactly the shape of problem
 * the raster ceiling exists to prevent.
 */
export const MAX_TABLES = intFromEnv('MAX_TABLES', 1_000, 1);

/**
 * Ceiling on the inflated size of `word/document.xml`.
 *
 * This is the decompression-bomb bound. The upload is capped at 25MB, but
 * 25MB of DEFLATE can inflate to gigabytes - that is what a bomb IS - and the
 * only place to stop it is before the inflate, against the size the archive's
 * own directory declares. 32MB is generously above the largest document that
 * can pass MAX_TABLE_CELLS, so honest documents never meet it and a bomb
 * always does.
 */
export const MAX_DOCUMENT_XML_BYTES = intFromEnv('MAX_DOCUMENT_XML_BYTES', 32 * MB, 1024);

/**
 * How many layers a PSD may hold before we refuse to extract its images.
 *
 * The direct analogue of MAX_TABLES, and necessary for the same reason: the
 * extractor holds a record for every layer - exported or skipped - and the
 * manifest is built from all of them, so a document of nothing but adjustment
 * layers costs memory per layer while producing no images at all. It is also
 * the first bound the reader applies, before it has decoded anything, because
 * the layer count is a field in the file's own header.
 *
 * Kept far below the 65535 entries our ZIP writer can address: past that the
 * archive itself would be corrupt, which is a worse failure than a refusal.
 */
export const MAX_PSD_LAYERS = intFromEnv('MAX_PSD_LAYERS', 500, 1);

/**
 * Ceiling on the pixel data a PSD's layers may declare, in bytes.
 *
 * This is the decompression-bomb bound, and unlike MAX_DOCUMENT_XML_BYTES it
 * cannot be derived from the upload size at all. The same reasoning as
 * MAX_TABLE_CELLS applies and is sharper here: a PSD declares the byte length
 * of every layer channel in its own header, a reader allocates what is
 * declared, and the declared number has nothing to do with how big the file is.
 * Measured: a 502-byte document declaring one 90MB channel is a file any of us
 * could write this afternoon.
 *
 * The reader refuses on the declared total before decoding anything, so this is
 * the figure that decides how much memory one conversion can ever ask for. 192MB
 * is chosen against the compose file's `mem_limit: 1g` together with
 * MAX_CONCURRENT_CONVERSIONS: two of these at once is under 400MB, which leaves
 * room for the two soffice processes the same limit has to cover.
 */
export const MAX_PSD_DECODE_BYTES = intFromEnv('MAX_PSD_DECODE_BYTES', 192 * MB, 1024);

/**
 * Ceiling on the PNG output one PSD may produce, in bytes.
 *
 * The second half of the same memory bound, and separate from the first because
 * they measure different things: this one is what we hand back, and the whole
 * archive is assembled in memory by the controller before any of it is sent -
 * see MAX_RASTER_PAGES, which exists for exactly this reason.
 *
 * The peak is not the archive alone. A layer is decoded (four bytes a pixel),
 * encoded into a fresh scanline buffer and then deflated, and the finished ZIP
 * is built by concatenating the parts - so the true high-water mark is several
 * times this number. 48MB keeps that in the same envelope as a 100-slide deck
 * at the raster target's 150 DPI, which is the figure the service already
 * accepted as the most a phone should be asked to download.
 */
export const MAX_LAYER_OUTPUT_BYTES = intFromEnv('MAX_LAYER_OUTPUT_BYTES', 48 * MB, 1024);

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

/**
 * The one browser origin allowed to call this API, or `''` for none.
 *
 * The frontend is served from a different hostname than the API, so the
 * browser treats every call as cross-origin and will not hand the response to
 * JavaScript unless the API says so. That is all CORS is: a rule browsers
 * enforce on themselves. It is not access control - a native client sends no
 * `Origin` at all and ignores these headers entirely, and anything that can
 * open a socket can leave the header off.
 *
 * Empty by default, which is the honest answer for most deployments of this
 * service: the Android client is unaffected either way, and a same-origin
 * frontend needs no header. Only a split frontend/API deployment sets it.
 *
 * MUST be a bare origin - scheme, host, optional port. A browser compares the
 * string to the request's `Origin` EXACTLY, so a trailing slash or a stray
 * path matches nothing and fails closed with a CORS error indistinguishable
 * from the server being down. That is a bad afternoon to debug, so it throws
 * at boot instead, naming the value it thinks you meant.
 */
function corsOriginFromEnv(): string {
  const raw = (process.env.CORS_ORIGIN ?? '').trim();
  if (raw === '') return '';

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `CORS_ORIGIN must be an origin like https://example.com, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.origin !== raw) {
    throw new Error(
      `CORS_ORIGIN must be a bare origin with no path, query or trailing slash, got ` +
        `${JSON.stringify(raw)} - did you mean ${JSON.stringify(parsed.origin)}?`,
    );
  }
  return raw;
}

export const CORS_ORIGIN = corsOriginFromEnv();

/** Run the boot-time warm-up conversions? Proves each pipeline end to end. */
export const SKIP_WARMUP = process.env.SKIP_WARMUP === '1';

/**
 * Serve the OpenAPI document and the Swagger UI.
 *
 * On by default: it is a static description of the public contract, contains
 * nothing sensitive, and the endpoints it documents are already public. Set
 * `ENABLE_DOCS=0` to turn it off.
 */
export const ENABLE_DOCS = process.env.ENABLE_DOCS !== '0';

/**
 * Fonts LibreOffice must be able to resolve to a metric-compatible substitute.
 *
 * Calibri and Cambria (and Arial / Times New Roman / Courier New) are Microsoft
 * fonts that are not present on Linux. Without the metric-compatible set,
 * LibreOffice substitutes a font with different glyph widths and every line
 * breaks in a different place - the document converts, the PDF looks right, and
 * the pagination silently disagrees with Word.
 *
 * This matters for every family, not just Writer: the same substitution changes
 * where text wraps in a chart label or an exported spreadsheet.
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

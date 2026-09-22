/**
 * The conversion matrix: what we accept, what it can become, and how.
 *
 * This file is the single source of truth for the service's capabilities. The
 * router, the upload filter, the OpenAPI document and `GET /formats` all derive
 * from it, so adding a format is a change here and nowhere else.
 *
 * Two things about it are worth knowing before reading on.
 *
 * 1. THE INPUT EXTENSION IS THE ONLY THING WE TRUST. LibreOffice chooses its
 *    import filter from the filename extension of the file it is handed, so we
 *    write the upload to disk as `<server-chosen-name>.<validated extension>`.
 *    The declared MIME type is ignored entirely - a hostile client can set it to
 *    anything, and the shipped Android client deliberately declares
 *    application/octet-stream for everything.
 *
 * 2. THE OUTPUT FILTER IS PER-FAMILY. LibreOffice's export filters are named
 *    after the document family, not the file type: PDF is `writer_pdf_Export`
 *    from Writer, `calc_pdf_Export` from Calc, and so on, and HTML is
 *    `HTML (StarWriter)` versus `HTML (StarCalc)`. That is why a target records
 *    a filter PER SOURCE FAMILY rather than one filter for everybody.
 *
 * Every filter name in here was verified against LibreOffice 24.2 by actually
 * running `soffice --convert-to` for that pair - see README "Conversion matrix".
 * Guessing at these is not possible: a wrong filter name is not an error, it is
 * a silent fallback to the default export, which produces a file of the right
 * type with the wrong content.
 */

/**
 * The LibreOffice document family that handles a file.
 *
 * This is the join key for filters: two sources in the same family convert the
 * same way, which is why `.doc` and `.docx` share an entry.
 */
export type DocumentFamily = 'writer' | 'calc' | 'impress' | 'draw';

/**
 * Microsoft Publisher (`.pub`) is deliberately not an accepted extension.
 * LibreOffice's Publisher import is historically weak and there is no way to
 * construct or verify a real `.pub` fixture in this environment - per the
 * project's "no filter is trusted until run against a real file" rule, it
 * stays out until someone can actually test it, not "add it and hope".
 */

/** Every format this service can produce, named by the URL segment that selects it. */
export type TargetId =
  | 'pdf'
  | 'odt'
  | 'docx'
  | 'txt'
  | 'html'
  | 'rtf'
  | 'epub'
  | 'ods'
  | 'xlsx'
  | 'csv'
  | 'odp'
  | 'pptx'
  | 'png'
  | 'jpg'
  | 'tables'
  | 'layers'
  | 'pdfa'
  | 'markdown'
  | 'zip'
  | 'tar'
  | 'tar.gz'
  | 'tar.bz2'
  | '7z'
  | 'bmp'
  | 'gif'
  | 'tiff'
  | 'webp'
  | 'avif'
  | 'ico'
  | 'png-image'
  | 'jpg-image'
  | 'cbz'
  | 'srt'
  | 'vtt'
  | 'ass'
  | 'ssa'
  | 'json'
  | 'yaml'
  | 'tsv'
  | 'jsonl'
  | 'svg'
  | 'heic'
  | 'heif'
  | 'emf'
  | 'wmf'
  | 'eps'
  | 'jxl'
  | 'jp2'
  | 'qoi'
  | 'tga'
  | 'pcx'
  | 'apng'
  | 'xml'
  | 'toml'
  | 'ini'
  | 'sqlite'
  | 'tar.zst'
  | 'obj'
  | 'stl'
  | 'ply'
  | 'glb'
  | '3mf'
  | 'mobi'
  | 'azw3'
  | 'fb2'
  | 'lrf'
  | 'pdb'
  | 'snb'
  | 'kepub'
  | 'ttf'
  | 'otf'
  | 'woff'
  | 'woff2'
  | 'parquet'
  | 'orc'
  | 'feather';

/** Every extension we accept as an upload. */
export type AllowedExtension =
  | '.docx'
  | '.docm'
  | '.doc'
  | '.dot'
  | '.dotx'
  | '.odt'
  | '.odg'
  | '.ods'
  | '.odp'
  | '.xlsx'
  | '.xls'
  | '.xlsm'
  | '.pptx'
  | '.ppt'
  | '.pptm'
  | '.pps'
  | '.ppsx'
  | '.pot'
  | '.potx'
  | '.csv'
  | '.txt'
  | '.html'
  | '.htm'
  | '.rtf'
  | '.png'
  | '.jpg'
  | '.jpeg'
  | '.psd'
  | '.pdf'
  | '.md'
  | '.rst'
  | '.tex'
  | '.textile'
  | '.org'
  | '.opml'
  | '.muse'
  | '.ipynb'
  | '.zip'
  | '.tar'
  | '.tgz'
  | '.tbz2'
  | '.txz'
  | '.gz'
  | '.bz2'
  | '.xz'
  | '.7z'
  | '.iso'
  | '.bmp'
  | '.gif'
  | '.tiff'
  | '.webp'
  | '.avif'
  | '.ico'
  | '.cbz'
  | '.srt'
  | '.vtt'
  | '.ass'
  | '.ssa'
  | '.json'
  | '.yaml'
  | '.yml'
  | '.tsv'
  | '.jsonl'
  | '.svg'
  | '.heic'
  | '.heif'
  | '.emf'
  | '.wmf'
  | '.eps'
  | '.jxl'
  | '.jp2'
  | '.qoi'
  | '.tga'
  | '.pcx'
  | '.apng'
  | '.xml'
  | '.toml'
  | '.ini'
  | '.sqlite'
  | '.zst'
  | '.obj'
  | '.stl'
  | '.ply'
  | '.glb'
  | '.3mf'
  | '.off'
  | '.epub'
  | '.mobi'
  | '.azw3'
  | '.fb2'
  | '.lrf'
  | '.pdb'
  | '.ttf'
  | '.otf'
  | '.woff'
  | '.woff2'
  | '.parquet'
  | '.orc'
  | '.feather'
  | '.eml';

/**
 * `png-image`/`jpg-image` reach a single transcoded PNG/JPEG file - and are
 * NOT the same thing `png`/`jpg` mean elsewhere in this table. Those two
 * ids already mean something fixed and load-bearing: "one image PER PAGE of
 * a presentation or PDF, always answered as a ZIP" (`mode: 'raster'`,
 * `multiple: true` - see `TargetFormat.mode`'s own comment). A plain image
 * source converting to a single PNG/JPEG file is a genuinely different
 * operation - one file in, one file out, never an archive - and `multiple`
 * is a property of the TARGET ID, fixed across every source that reaches
 * it, not something a pair can override. Reusing `png`/`jpg` for this would
 * mean either breaking that promise for existing raster consumers or
 * wrapping a single transcoded image in a one-entry ZIP, which is a worse
 * response for the common case a person asking to "convert my BMP to PNG"
 * actually wants.
 *
 * The codebase's own precedent for exactly this shape of collision is
 * `tables` vs `xlsx` and `layers` vs `png`: a differently-shaped operation
 * gets its own name rather than a second meaning bolted onto an existing
 * one - `png-image`/`jpg-image` follow it the same way. First left out of
 * an earlier pass of this feature as a need nobody had asked for yet; added
 * once someone did (a person converting a plain image expects to be able to
 * ask for PNG or JPEG, which is the single most common image conversion
 * there is).
 */

/**
 * RAR (`.rar`) is deliberately not an accepted extension. `7z` can read it
 * (`7z i` lists both `Rar` and `Rar5` as recognised formats), but there is no
 * legal way to author a REAL `.rar` fixture to verify that reading against in
 * this environment - the format's writer is a proprietary tool, unlike every
 * other archive format here. Same reasoning as `.pub` in the legacy-Office
 * extensions above: not trusted until run against a real file, and there is
 * no real file to run it against yet.
 *
 * Writing `.rar` was never in scope regardless: even CloudConvert's own
 * public catalogue routes RAR *creation* through a separate, proprietary,
 * credit-gated engine - `7z`/p7zip can only read the format, never write it.
 */

/**
 * The pandoc-readable markup/plain-text sources - see `pandoc.service.ts`.
 *
 * One list, referenced by every target pandoc reaches, so a new markup
 * source is one line here rather than a change to five different targets.
 *
 * AsciiDoc (`.adoc`) is deliberately not in this list - see the note at the
 * top of `pandoc.service.ts` for why: the pandoc build this service was
 * verified against has no AsciiDoc reader at all.
 */
export const MARKUP_EXTENSIONS: readonly AllowedExtension[] = [
  '.md',
  '.rst',
  '.tex',
  '.textile',
  '.org',
  '.opml',
  '.muse',
  '.ipynb',
];

/**
 * The archive-engine sources - see `archive.service.ts`.
 *
 * `.tar.gz`/`.tar.bz2`/`.tar.xz` are deliberately NOT extensions of their
 * own: `extname()` (used by the upload filter - see
 * `middleware/convert-upload.ts`) only ever returns the LAST extension, so a
 * `report.tar.gz` upload is already accepted as `.gz`, which reads correctly
 * because `archive.service.ts`'s extraction is content-based, not name-based
 * - it recurses into a compound source's inner `.tar` regardless of what the
 * outer file was called. `.tgz`/`.tbz2`/`.txz` are listed here because those
 * ARE single, whole extensions `extname()` returns intact.
 */
export const ARCHIVE_EXTENSIONS: readonly AllowedExtension[] = [
  '.zip',
  '.tar',
  '.tgz',
  '.tbz2',
  '.txz',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.iso',
  // `.cbz` is a comic-book archive - a plain ZIP of page images under a
  // reader-recognised extension, nothing more - so it rides this exact
  // engine unchanged: `7z`/`zipDeflated` neither know nor care what the
  // files inside happen to be.
  '.cbz',
];

/**
 * The ffmpeg-transcode target ids - see `ffmpeg.service.ts` and the note
 * above `AllowedExtension` on why `png`/`jpg` are not among them.
 *
 * One list, referenced by every image source, so that a new transcode
 * target is one line here rather than a change to seven different sources.
 */
const TRANSCODE_TARGETS: readonly TargetId[] = [
  'bmp',
  'gif',
  'tiff',
  'webp',
  'avif',
  'ico',
  'png-image',
  'jpg-image',
  'jxl',
  'jp2',
  'qoi',
  'tga',
  'pcx',
  'apng',
];

/**
 * The subtitle-transcode target ids - `ffmpeg` again, but a second, SEPARATE
 * flat list from `TRANSCODE_TARGETS` rather than an extension of it: mixing
 * the two would let an image source claim `srt` as a target (and vice
 * versa), which is nonsense `resolveConversion` would happily accept since
 * `mode: 'transcode'` alone decides the engine. Kept apart the same way
 * `formats-media.ts` keeps audio and video apart, just expressed as two
 * lists in this file instead of a second file, because - unlike media -
 * this reuses the ordinary synchronous `/convert/{target}` engine
 * (`runFfmpeg`/`runFfmpegPipeline`) rather than needing a matrix of its own:
 * a subtitle file is tiny text, converts in well under a second, and has
 * none of the "this could run for minutes" reasoning that sent audio/video
 * to the async job endpoint.
 *
 * Deliberately four formats, not six. Every one of `srt`/`vtt`/`ass`/`ssa`
 * was verified by hand, both reading and writing, with the exact zero-flag
 * `ffmpeg -y -i in out` command `runFfmpeg` issues (the `-frames:v 1
 * -update 1` it always adds is a no-op here - verified too - since a
 * subtitle-only input has no video stream for those flags to act on).
 * MicroDVD (`.sub`) and MPL2 (`.mpl`) were tried and left out: this ffmpeg
 * build has no MUXER for either at all (`ffmpeg -muxers` lists both as
 * decode-only), so there is no way to ever produce one, and MicroDVD's own
 * demuxer additionally refuses to even READ a file without an explicit
 * `-framerate` flag (its timestamps are frame counts, not clock time) -
 * a per-pair flag this generic, flag-free engine has nowhere to carry.
 * Adding either would mean a second ffmpeg invocation shape just for them,
 * which is a different feature, not a line in this list.
 */
const SUBTITLE_TRANSCODE_TARGETS: readonly TargetId[] = ['srt', 'vtt', 'ass', 'ssa'];

/**
 * The `heif`-engine target ids - `heic` and `heif`, reachable from every
 * ordinary image source (`TRANSCODE_TARGETS`'s own sources, plus `.png`/
 * `.jpg`/`.jpeg`/`.svg`) the same way `TRANSCODE_TARGETS` itself is appended
 * to each of those sources' own `targets` list, rather than folded into
 * `TRANSCODE_TARGETS` directly - see `TargetFormat.mode`'s own `heif` bullet
 * for why these two need a mode, and an engine, of their own.
 */
const HEIF_TARGETS: readonly TargetId[] = ['heic', 'heif'];

/**
 * The `font`-engine target ids and source extensions - `.ttf`/`.otf`/
 * `.woff`/`.woff2`, flat like `TRANSCODE_TARGETS`/`ASSIMP_TARGETS` (every
 * source reaches every OTHER target, no per-family filter). See
 * `font.service.ts`/`font_engine.py`.
 */
const FONT_TARGETS: readonly TargetId[] = ['ttf', 'otf', 'woff', 'woff2'];

/**
 * The `assimp`-engine target ids - see `assimp.service.ts`. `.off` is
 * deliberately NOT among them: it is a real, verified SOURCE (`assimp
 * listext` reads it) but not a real export format at all (`assimp
 * listexport` does not list it, and asking for it fails outright) - the
 * same asymmetric "one direction is tested, the other is not" shape `.rar`
 * has elsewhere in this service.
 */
const ASSIMP_TARGETS: readonly TargetId[] = ['obj', 'stl', 'ply', 'glb', '3mf'];

/**
 * The `ebook`-engine target ids - see `ebook.service.ts`. `epub` is
 * deliberately NOT among them: it is an EXISTING `mode: 'direct'` target
 * (LibreOffice's own `writer` EPUB filter already writes it for every
 * writer-family source), and this group reaches that SAME id through
 * `engineFrom.ebook` instead - the same second-route shape a PDF already
 * uses to reach `docx`/`pptx`/`xlsx`, so `resolveConversion` never has to
 * choose between two conflicting definitions of what `epub` means. `kepub`
 * IS in this list despite having no dedicated SOURCE extension of its own -
 * see its own `TargetFormat` entry for why.
 */
const EBOOK_TARGETS: readonly TargetId[] = ['mobi', 'azw3', 'fb2', 'lrf', 'pdb', 'snb', 'kepub'];

/**
 * Every source `ebook-convert` reads - `.snb` deliberately excluded, see
 * `ebook.service.ts`'s own header comment for the real bug that makes it
 * untrustworthy as a source in this build. `.epub` is included: it is a new
 * source this feature adds (LibreOffice/pandoc only ever WROTE `.epub`
 * before now), read by the same `ebook-convert` this whole group uses.
 */
const EBOOK_EXTENSIONS: readonly AllowedExtension[] = [
  '.epub',
  '.mobi',
  '.azw3',
  '.fb2',
  '.lrf',
  '.pdb',
];

/**
 * The data-interchange target ids - `data.service.ts`, pure JS, no
 * subprocess. A third flat list, alongside `TRANSCODE_TARGETS` and
 * `SUBTITLE_TRANSCODE_TARGETS`, for the same reason those two are kept
 * apart from each other: mixing kinds would let an image or a subtitle
 * source claim `json` as a target, which nothing about `mode: 'data'` alone
 * would stop.
 *
 * `csv` is deliberately NOT in this list, even though it is a full member
 * of the group every other source here reaches it as a target and is
 * reached BY as a source. It is the one id in this group that already
 * existed before this group did - `TARGETS.csv` is a `direct` LibreOffice
 * export (`.docx`/`.xlsx` -> CSV via Calc), and that route is untouched.
 * A source in THIS group reaches it through `TARGETS.csv.engineFrom.data`
 * instead - the same second-route shape `docx`/`xlsx`/`markdown` already
 * use for their PDF/pandoc engine routes - so `resolveConversion` never has
 * to choose between two conflicting definitions of what "csv" means.
 */
const DATA_TARGETS: readonly TargetId[] = [
  'tsv',
  'json',
  'yaml',
  'jsonl',
  'xml',
  'toml',
  'ini',
  'sqlite',
  'parquet',
  'orc',
  'feather',
];

/** Every data-engine source extension, `csv` included - see `DATA_TARGETS`'s own comment for why `csv` the TARGET id is handled separately from `csv` the SOURCE extension. */
const DATA_EXTENSIONS: readonly AllowedExtension[] = [
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.jsonl',
  '.xml',
  '.toml',
  '.ini',
  '.sqlite',
  '.parquet',
  '.orc',
  '.feather',
];

/**
 * The three `DATA_TARGETS`/`DATA_EXTENSIONS` members that are NOT pure JS -
 * `arrow.service.ts` shells out to `scripts/arrow_engine.py` (`pyarrow`) for
 * all three, the one subprocess-backed corner of an otherwise pure-JS
 * engine. `runDataPipeline` in `conversion.service.ts` checks this set
 * before deciding whether to call `data.service.ts`'s own synchronous
 * parse/serialize or `arrow.service.ts`'s async ones - see its own comment.
 */
export const ARROW_TARGETS: ReadonlySet<TargetId> = new Set(['parquet', 'orc', 'feather']);
export const ARROW_EXTENSIONS: ReadonlySet<AllowedExtension> = new Set(['.parquet', '.orc', '.feather']);

export interface TargetFormat {
  id: TargetId;
  /** Extension of a produced file, including the dot. */
  extension: string;
  /** Media type of a single-file response. */
  mediaType: string;
  /** Short name for the list in an error message: "PDF", "XLSX". */
  label: string;
  /**
   * How the target is produced.
   *
   *   - `direct` - one `soffice --convert-to <filter>` and we are done.
   *   - `raster` - the source is rendered to PDF first and the PDF is then
   *     rasterised into ONE IMAGE PER PAGE, because LibreOffice's command-line
   *     image export only ever writes the first page of a presentation. See
   *     `rasterizePdf` in services/conversion.service.ts.
   *   - `extract` - LibreOffice is not involved at all. Either a part is read
   *     out of the upload's own package - which is what makes a Word
   *     document's tables available as a workbook - or the upload is read
   *     whole, which is what makes a PSD's layers available as images. The
   *     engine is named by `extractFrom` rather than by a filter, and it is
   *     this mode that makes the service more than a LibreOffice front end.
   *   - `archive` - `7z` (p7zip), run as a subprocess: the source archive is
   *     listed, validated and unpacked, then the resulting file tree is
   *     packed into the target format. See `archive.service.ts` for why this
   *     is NOT the same shape as `extract` - it genuinely unpacks untrusted
   *     bytes to disk, which `extract` never does. `archiveWriter` names
   *     which writer `conversion.service.ts` calls for it.
   *   - `transcode` - `ffmpeg`, run as a subprocess: one image (or subtitle)
   *     format straight to another, with no document family to key a filter
   *     on - unlike `soffice`'s `direct` mode, `ffmpeg` is a flat
   *     format-to-format tool, so there is nothing for a per-family filter
   *     table to express. See `ffmpeg.service.ts`.
   *   - `data` - pure JS, no subprocess at all: CSV/TSV/JSON/JSONL/YAML,
   *     read into one common JS value and written back out. Flat like
   *     `transcode`, for the same reason (no document family applies), but
   *     its own mode rather than folded into `transcode` because nothing
   *     here is `ffmpeg` - see `data.service.ts`.
   *   - `heif` - `libheif`'s `heif-convert`/`heif-enc`, run as subprocesses,
   *     for `heic`/`heif` in EITHER direction. Not folded into `transcode`
   *     even though it is flat/family-less the same way: this build's
   *     `ffmpeg` has no HEIF demuxer or encoder at all (verified by hand -
   *     `ffmpeg -demuxers`/`-decoders` list no `heif`), so a `.heic`/`.heif`
   *     source or target needs a second subprocess `ffmpeg` never touches.
   *     `heif-convert` can write `.jpg`/`.jpeg`/`.png`/`.tif`/`.tiff`
   *     directly from a HEIC/HEIF source; anything else in
   *     `TRANSCODE_TARGETS` goes through an intermediate PNG that `ffmpeg`
   *     then transcodes, same as any other `transcode` pair. `heif-enc` only
   *     reads PNG/JPEG (verified by hand - a `.bmp` input fails with "Not a
   *     JPEG file"), so producing `heic`/`heif` from any OTHER image source
   *     first runs that source through the ordinary `ffmpeg` transcode to an
   *     intermediate PNG. See `heif.service.ts`.
   *
   * `mode` describes the LIBREOFFICE-OR-NOT route a target normally takes.
   * `engineFrom`, below, is orthogonal to it: `docx`/`pptx`/`xlsx` are
   * `direct` LibreOffice exports for every source that reaches them through
   * `filters` - and, separately, a PDF reaches those same three ids through a
   * second, non-LibreOffice engine, because a PDF opens in LibreOffice as a
   * Draw document and Draw has no Writer/Calc/Impress export filter to reach
   * any of them. `resolveConversion` checks `engineFrom` before `filters`,
   * so the id a client asks for names the FORMAT, not which engine happened
   * to produce it - which is the whole point: nobody converting a PDF to a
   * Word document should have to know that this service uses a different
   * program to do it than a `.doc` upload does.
   *
   * `mode` says how the bytes are produced and nothing else. What the response
   * LOOKS like is `multiple`, below, because the two genuinely vary apart:
   * `tables` and `layers` are both extracts and one answers with a single
   * workbook while the other answers with an archive.
   */
  mode: 'direct' | 'raster' | 'extract' | 'archive' | 'transcode' | 'data' | 'heif' | '3d' | 'ebook' | 'font';
  /**
   * `mode: 'archive'` only: which writer `archive.service.ts` calls.
   * `'zip'` goes through `zip.ts`'s own `zipDeflated`, not a `7z` subprocess
   * - see `createArchive`'s own comment for why. Absent for every other mode.
   */
  archiveWriter?: 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.zst' | '7z';
  /**
   * Does this target answer with a ZIP of several files rather than one file?
   *
   * Declared rather than derived, because it is not derivable: a raster target
   * is always `true` (one image per page, and it archives even for a
   * single-page source so that the response type does not depend on how many
   * slides the upload happened to have), a direct target is always `false`,
   * an archive target is always `false` too (the response IS the one archive
   * file the client asked for, not a wrapper around several), a transcode
   * target is always `false` (one image in, one image out), and the two
   * extract targets differ from each other in exactly this respect.
   * `validateMatrix` pins the two fixed cases so a target cannot contradict
   * itself here.
   *
   * What this must NOT be confused with is "did the conversion happen to
   * produce more than one file", which is the tempting derivation and the wrong
   * one: a one-layer PSD has to answer with a ZIP just as a thirty-slide deck
   * does, or the content type becomes a function of the document.
   */
  multiple: boolean;
  /** `direct`: the `--convert-to` argument, for each family that can produce it. */
  filters: Partial<Record<DocumentFamily, string>>;
  /**
   * For `extract`: the sources the engine can read, named explicitly.
   *
   * Keyed by EXTENSION and not by family, because the property an extract
   * depends on is never the document family - it is something about the bytes
   * that the family cannot express. For `tables` it is "a ZIP of XML parts":
   * `.docx` and `.docm` are both `writer`, and so is `.doc`, which is a binary
   * container no ZIP reader can open. For `layers` it is "a Photoshop document",
   * which belongs to no family at all. A second list rather than a reuse of
   * `filters`, because the two are keyed on different things and mean different
   * things.
   *
   * `validateMatrix` checks it in both directions, so this cannot drift out of
   * agreement with the sources that advertise the target.
   *
   * Two targets can name the same extension for their output - `xlsx` and
   * `tables` both write `.xlsx`, `png` and `layers` both write `.png` - because
   * in each pair one is an extract of the same FORMAT by different means. It is
   * a target's `multiple` that says whether the response is that file or an
   * archive of them.
   */
  extractFrom?: readonly AllowedExtension[];
  /**
   * Sources that reach this target through a non-LibreOffice engine instead
   * of through `filters` - today, a PDF (via `pdf_engine.py`, see
   * `pdf-engine.service.ts`) reaching `docx`/`pptx`/`xlsx`/`markdown`, the
   * pandoc-readable markup formats (via `pandoc.service.ts`) reaching
   * `docx`/`html`/`odt`/`rtf`/`txt`/`markdown`, and the OTHER data-engine
   * formats (via `data.service.ts`) reaching `csv` - see `DATA_TARGETS`'s
   * own comment for why `csv` needs this rather than just being `mode:
   * 'data'` outright.
   *
   * Keyed by engine rather than a flat list, because there are now three
   * independent non-LibreOffice engines and a source can only ever reach a
   * given target through ONE of them - `resolveConversion` needs to know
   * which, so it knows which service to call. `ResolvedConversion.engine`
   * carries that same choice forward to the caller.
   *
   * A second, independent route to the SAME target id, not a target of its
   * own the way `extractFrom` is for `tables`/`layers`: those two are lossy
   * in a way that a plain `docx`/`xlsx` promise is not, so they earned
   * separate ids. A PDF's or a Markdown file's `docx` is a genuine
   * reconstruction of the same format the id already means, so it answers
   * to the same name - the engine that produced it is an implementation
   * detail `resolveConversion` resolves, not something the URL should ever
   * have to say.
   *
   * `validateMatrix` checks this the same way it checks `extractFrom`: every
   * named source must offer this target id, and every source that offers
   * this id via an engine route (rather than via `filters`) must be named
   * here, under exactly one engine.
   */
  engineFrom?: {
    pdf?: readonly AllowedExtension[];
    pandoc?: readonly AllowedExtension[];
    data?: readonly AllowedExtension[];
    ebook?: readonly AllowedExtension[];
    email?: readonly AllowedExtension[];
  };
}

/**
 * The output formats, keyed by id.
 *
 * Filter arguments are written exactly as `soffice` expects them on the command
 * line: `<extension>:<filter>`, with a third colon-separated field for filter
 * options (used by CSV and plain text, where the default encoding is not UTF-8
 * and the default separator is not the comma we want).
 */
export const TARGETS: Readonly<Record<TargetId, TargetFormat>> = {
  pdf: {
    id: 'pdf',
    extension: '.pdf',
    mediaType: 'application/pdf',
    label: 'PDF',
    mode: 'direct',
    multiple: false,
    filters: {
      writer: 'writer_pdf_Export',
      calc: 'calc_pdf_Export',
      impress: 'impress_pdf_Export',
      draw: 'draw_pdf_Export',
    },
  },
  odt: {
    id: 'odt',
    extension: '.odt',
    mediaType: 'application/vnd.oasis.opendocument.text',
    label: 'ODT',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'writer8' },
    // A markup source has no LibreOffice family, so it reaches ODT through
    // pandoc's own `odt` writer rather than a filter - see `pandoc.service.ts`.
    engineFrom: { pandoc: MARKUP_EXTENSIONS },
  },
  docx: {
    id: 'docx',
    extension: '.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'MS Word 2007 XML' },
    // From a PDF, this is `pdf_engine.py`'s docx operation (pdf2docx/PyMuPDF)
    // rebuilding real paragraphs, tables and images as OOXML - a genuine
    // reconstruction of a Word document, not a raster fallback, which is why
    // it answers to the same `docx` id rather than a lossy-extract id of its
    // own. See the note on `engineFrom` for why this differs from `tables`.
    // From a markup source (`.md`/`.rst`/...), it is pandoc's own `docx`
    // writer - also a genuine, editable OOXML package, not a fallback.
    engineFrom: { pdf: ['.pdf'], pandoc: MARKUP_EXTENSIONS },
  },
  txt: {
    id: 'txt',
    extension: '.txt',
    mediaType: 'text/plain; charset=utf-8',
    label: 'TXT',
    mode: 'direct',
    multiple: false,
    // `Text (encoded)` with an explicit UTF8 option: the bare `Text` filter
    // writes in the process locale, which would mangle anything non-ASCII into
    // question marks while still reporting success.
    filters: { writer: 'Text (encoded):UTF8' },
    // `.eml` reaches this SAME id too - see `email.service.ts`'s own header
    // comment for what "converting" an email to plain text actually means
    // here (a short From/To/Subject/Date header block plus the body).
    engineFrom: { pandoc: MARKUP_EXTENSIONS, email: ['.eml'] },
  },
  html: {
    id: 'html',
    extension: '.html',
    mediaType: 'text/html; charset=utf-8',
    label: 'HTML',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'HTML (StarWriter)', calc: 'HTML (StarCalc)' },
    // Same `.eml` route as `txt` above.
    engineFrom: { pandoc: MARKUP_EXTENSIONS, email: ['.eml'] },
  },
  rtf: {
    id: 'rtf',
    extension: '.rtf',
    mediaType: 'application/rtf',
    label: 'RTF',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'Rich Text Format' },
    engineFrom: { pandoc: MARKUP_EXTENSIONS },
  },
  epub: {
    id: 'epub',
    extension: '.epub',
    mediaType: 'application/epub+zip',
    label: 'EPUB',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'EPUB' },
    // The ebook sources (`.mobi`/`.azw3`/`.fb2`/`.lrf`/`.pdb`) reach this
    // SAME id through `ebook-convert` instead - see `EBOOK_TARGETS`'s own
    // comment for why `epub` keeps its existing `direct` mode rather than
    // becoming `mode: 'ebook'` outright, the same second-route shape a PDF
    // already uses for `docx`/`pptx`/`xlsx`.
    engineFrom: { ebook: EBOOK_EXTENSIONS.filter((ext) => ext !== '.epub') },
  },
  ods: {
    id: 'ods',
    extension: '.ods',
    mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
    label: 'ODS',
    mode: 'direct',
    multiple: false,
    filters: { calc: 'calc8' },
  },
  xlsx: {
    id: 'xlsx',
    extension: '.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    mode: 'direct',
    multiple: false,
    filters: { calc: 'Calc MS Excel 2007 XML' },
    // From a PDF, this is `pdf_engine.py`'s xlsx operation (pdfplumber),
    // finding tables by their drawn lines - lossy in the same direction as
    // `tables` (prose and images are dropped) but still answering the
    // `xlsx` id rather than a name of its own, because a workbook is what
    // both promise and a PDF has no faithful, non-lossy spreadsheet export
    // to compare it against the way `.docx` -> `xlsx` would. A PDF with no
    // ruled table found answers E_NO_TABLES, exactly as `tables` does.
    // Pandoc reaches no spreadsheet writer worth trusting - it is a markup
    // engine, not a table-extraction one - so no markup source names this
    // target.
    engineFrom: { pdf: ['.pdf'] },
  },
  csv: {
    id: 'csv',
    extension: '.csv',
    mediaType: 'text/csv; charset=utf-8',
    label: 'CSV',
    mode: 'direct',
    multiple: false,
    // The filter options are positional, in this order:
    //   field separator (44 = ','), text delimiter (34 = '"'),
    //   character set (76 = UTF-8), first line number (1),
    //   cell format codes (empty = default), language id (0),
    //   quoted field as text (false), detect special numbers (true),
    //   save cell contents as shown (true).
    // Without them the export uses the process locale's separator and encoding.
    filters: { calc: 'Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true' },
    // The other data-engine formats (`.tsv`/`.json`/`.yaml`/`.yml`/`.jsonl`)
    // reach CSV through `data.service.ts` rather than through `filters` -
    // see `DATA_TARGETS`'s own comment for why `csv` keeps its existing
    // `direct` LibreOffice route for `.docx`/`.xlsx` untouched rather than
    // becoming `mode: 'data'` outright.
    engineFrom: { data: DATA_EXTENSIONS.filter((ext) => ext !== '.csv') },
  },
  odp: {
    id: 'odp',
    extension: '.odp',
    mediaType: 'application/vnd.oasis.opendocument.presentation',
    label: 'ODP',
    mode: 'direct',
    multiple: false,
    filters: { impress: 'impress8' },
  },
  pptx: {
    id: 'pptx',
    extension: '.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    mode: 'direct',
    multiple: false,
    filters: { impress: 'Impress MS PowerPoint 2007 XML' },
    // From a PDF, this is `pdf_engine.py`'s pptx operation: one slide per
    // page, each page rendered whole as that slide's image. There is no
    // PDF-to-Impress import to reconstruct editable shapes from, so this is
    // the same fallback real "PDF to PowerPoint" tools use for anything not
    // already a native deck - lossier than the `docx` route (no editable
    // text) and still a genuine, openable `.pptx`, which is why it answers
    // to this id rather than a name of its own.
    engineFrom: { pdf: ['.pdf'] },
  },
  png: {
    id: 'png',
    extension: '.png',
    mediaType: 'image/png',
    label: 'PNG',
    mode: 'raster',
    multiple: true,
    filters: {},
  },
  jpg: {
    id: 'jpg',
    extension: '.jpg',
    mediaType: 'image/jpeg',
    label: 'JPG',
    mode: 'raster',
    multiple: true,
    filters: {},
  },
  tables: {
    id: 'tables',
    extension: '.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    /**
     * Distinct from `xlsx`'s label, because these two are the only targets
     * that share one and the error messages list labels rather than ids.
     * Listing "XLSX" twice in one sentence leaves the reader to guess which is
     * which; naming what is in the workbook does not.
     */
    label: 'XLSX (tables)',
    /**
     * Every table in the document, as one worksheet each.
     *
     * This is its own target rather than letting `.docx` reach `xlsx`,
     * and the reason is that the two are not the same operation. `xlsx` from a
     * spreadsheet is a faithful conversion of the whole document by
     * LibreOffice; this is an extraction that keeps the tables and drops
     * everything else - the prose, the headings, the images, the styles. If
     * they shared an id then `GET /formats` would advertise `xlsx` for a .docx
     * and the person asking for it would reasonably expect a Word-faithful
     * workbook. The lossy one should not answer to the name of the faithful
     * one, so the distinction lives in the address.
     */
    mode: 'extract',
    multiple: false,
    filters: {},
    extractFrom: ['.docx', '.docm'],
  },
  layers: {
    id: 'layers',
    /**
     * A PNG, because that is what the archive holds - one per layer. The
     * RESPONSE is always a ZIP, which is what `multiple` says; `extension` and
     * `mediaType` describe the files inside it, exactly as they do for `png`
     * and `jpg`, whose responses are also always archives. A client that wants
     * to know what it is unwrapping reads `multiple` for the shape and this for
     * the contents.
     */
    extension: '.png',
    mediaType: 'image/png',
    /**
     * Distinct from `png`'s label for the same reason `tables` is distinct from
     * `xlsx`: a 415 or a bad target id gets answered with a list of labels, and
     * "PNG" appearing twice in one sentence tells the reader nothing about
     * which one they wanted.
     */
    label: 'PNG (layers)',
    /**
     * Every layer of a Photoshop document, as its own PNG.
     *
     * Not reachable from any LibreOffice format, and not a conversion in any
     * sense LibreOffice would recognise: a PSD is not a document LibreOffice
     * opens, so there is no filter to write and no family to key one on. What
     * it shares with `tables` is the shape of the work - the upload is read by
     * our own code and the answer is built from what is inside it - which is
     * what `mode: 'extract'` means here.
     */
    mode: 'extract',
    multiple: true,
    filters: {},
    extractFrom: ['.psd'],
  },
  pdfa: {
    id: 'pdfa',
    extension: '.pdf',
    mediaType: 'application/pdf',
    /**
     * Distinct from `pdf`'s label for the same reason `tables` is distinct
     * from `xlsx`: this is a lossy, standards-flattening re-export of a PDF
     * that already exists, not the faithful "render this document to PDF"
     * the `pdf` target promises everywhere else - and a source can never
     * reach `pdf` with its own extension anyway (see `validateMatrix`'s
     * self-target check), so this needed its own id regardless.
     */
    label: 'PDF/A',
    /**
     * A PDF re-exported through Draw with `SelectPdfVersion` forced to 1
     * (PDF/A-1b) - the one direct, LibreOffice-backed target a PDF source can
     * reach, since Draw is the only family a PDF ever opens as. Verified with
     * `soffice --convert-to`: the filter argument is exactly this string,
     * including the embedded JSON, in the same colon-joined shape the CSV
     * target already uses for its own filter options.
     */
    mode: 'direct',
    multiple: false,
    filters: { draw: 'draw_pdf_Export:{"SelectPdfVersion":{"type":"long","value":1}}' },
  },
  markdown: {
    id: 'markdown',
    extension: '.md',
    mediaType: 'text/markdown; charset=utf-8',
    label: 'Markdown',
    /**
     * `mode: 'direct'` with an EMPTY `filters` table - there is no
     * LibreOffice export filter for Markdown at all, so unlike `docx`/
     * `pptx`/`xlsx` (each reachable two ways: a real filter for a native
     * source, `pdf_engine.py` for a PDF) this target is reachable only
     * through the engine. `validateMatrix`'s "a direct target must declare
     * filters" rule is relaxed for exactly this case - see its own comment -
     * because the real invariant is "reachable by SOME mechanism", and
     * `engineFrom` below is that mechanism.
     */
    mode: 'direct',
    multiple: false,
    filters: {},
    // `pdf_engine.py`'s markdown operation: PyMuPDF for text/heading/list
    // structure recovered by font-size heuristic, pdfplumber for tables,
    // interleaved in each page's own reading order. Lossy in a different
    // direction than `tables`/`layers` (this keeps prose and structure,
    // those keep only tables/images) and lossy in a different direction
    // than `docx` (this is heuristic reconstruction from formatting, not
    // pdf2docx's structural rebuild) - which is why it is its own target
    // rather than folded into either.
    //
    // pandoc's own `gfm` writer for every OTHER markup source - genuinely
    // faithful, not heuristic, which is why `.md` itself is excluded: a
    // Markdown file "converting" to Markdown is not a conversion this
    // service should advertise, matrix self-target check or not (that check
    // compares `source.targets` against `ext.slice(1)`, which is `'md'`, not
    // the id `'markdown'` - so it would not have caught this on its own).
    engineFrom: { pdf: ['.pdf'], pandoc: MARKUP_EXTENSIONS.filter((ext) => ext !== '.md') },
  },
  zip: {
    id: 'zip',
    extension: '.zip',
    // The SAME media type the raster/layers targets already answer with for
    // a multi-file ZIP - not a new ambiguity, because `multiple: false` here
    // is what tells them apart: this response IS the one file the client
    // asked for, not several files wrapped in one.
    mediaType: 'application/zip',
    label: 'ZIP',
    mode: 'archive',
    archiveWriter: 'zip',
    multiple: false,
    filters: {},
  },
  tar: {
    id: 'tar',
    extension: '.tar',
    mediaType: 'application/x-tar',
    label: 'TAR',
    mode: 'archive',
    archiveWriter: 'tar',
    multiple: false,
    filters: {},
  },
  'tar.gz': {
    id: 'tar.gz',
    extension: '.tar.gz',
    mediaType: 'application/gzip',
    label: 'TAR.GZ',
    mode: 'archive',
    archiveWriter: 'tar.gz',
    multiple: false,
    filters: {},
  },
  'tar.bz2': {
    id: 'tar.bz2',
    extension: '.tar.bz2',
    mediaType: 'application/x-bzip2',
    label: 'TAR.BZ2',
    mode: 'archive',
    archiveWriter: 'tar.bz2',
    multiple: false,
    filters: {},
  },
  '7z': {
    id: '7z',
    extension: '.7z',
    mediaType: 'application/x-7z-compressed',
    label: '7Z',
    mode: 'archive',
    archiveWriter: '7z',
    multiple: false,
    filters: {},
  },
  cbz: {
    id: 'cbz',
    extension: '.cbz',
    mediaType: 'application/vnd.comicbook+zip',
    label: 'CBZ',
    /**
     * The same `zip` writer every other `zip`-shaped target already uses
     * (`archiveWriter: 'zip'` goes through `zip.ts`'s `zipDeflated`, never a
     * `7z` subprocess - see `createArchive`'s own comment for why). A CBZ
     * IS a ZIP; the extension is the only thing that makes a comic reader
     * recognise it as one, so there is no separate writer to build - this
     * target exists to put that recognised extension on an otherwise
     * ordinary `zip` archive job.
     */
    mode: 'archive',
    archiveWriter: 'zip',
    multiple: false,
    filters: {},
  },
  srt: {
    id: 'srt',
    extension: '.srt',
    mediaType: 'application/x-subrip',
    label: 'SRT',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  vtt: {
    id: 'vtt',
    extension: '.vtt',
    mediaType: 'text/vtt',
    label: 'VTT',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  ass: {
    id: 'ass',
    extension: '.ass',
    mediaType: 'text/x-ass',
    label: 'ASS',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  ssa: {
    id: 'ssa',
    extension: '.ssa',
    mediaType: 'text/x-ssa',
    label: 'SSA',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  tsv: {
    id: 'tsv',
    extension: '.tsv',
    mediaType: 'text/tab-separated-values; charset=utf-8',
    label: 'TSV',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  json: {
    id: 'json',
    extension: '.json',
    mediaType: 'application/json; charset=utf-8',
    label: 'JSON',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  yaml: {
    id: 'yaml',
    extension: '.yaml',
    mediaType: 'application/yaml; charset=utf-8',
    label: 'YAML',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  jsonl: {
    id: 'jsonl',
    extension: '.jsonl',
    mediaType: 'application/jsonl; charset=utf-8',
    label: 'JSONL',
    /**
     * "JSON Lines" - one JSON value per line, always a top-level array in
     * this engine's own common value model (see `data.service.ts`'s header
     * comment). Its shape requirement is looser than CSV/TSV's ("a
     * top-level array" rather than "a top-level array of FLAT objects")
     * because each line is independently valid JSON with no delimited-text
     * column structure to preserve - nesting inside an element is fine.
     */
    mode: 'data',
    multiple: false,
    filters: {},
  },
  bmp: {
    id: 'bmp',
    extension: '.bmp',
    mediaType: 'image/bmp',
    label: 'BMP',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  gif: {
    id: 'gif',
    extension: '.gif',
    mediaType: 'image/gif',
    label: 'GIF',
    // A still image, always: `ffmpeg.service.ts` passes `-frames:v 1`, so an
    // animated GIF *source* becomes its first frame here, same as it does
    // for every other transcode target - this is not an animation pipeline.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  tiff: {
    id: 'tiff',
    extension: '.tiff',
    mediaType: 'image/tiff',
    label: 'TIFF',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  webp: {
    id: 'webp',
    extension: '.webp',
    mediaType: 'image/webp',
    label: 'WEBP',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  avif: {
    id: 'avif',
    extension: '.avif',
    mediaType: 'image/avif',
    label: 'AVIF',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  ico: {
    id: 'ico',
    extension: '.ico',
    mediaType: 'image/x-icon',
    label: 'ICO',
    /**
     * The one transcode target with a real, format-level limitation worth
     * stating here rather than leaving a person to discover it from a
     * generic `E_CONVERT_FAILED`: ICO cannot hold an image over 256x256 -
     * verified by hand (`ffmpeg` refuses with "Unsupported dimensions
     * ... (dimensions cannot exceed 256x256)" and a non-zero exit for
     * anything larger). This service does not silently downscale to make a
     * request succeed - it does not do that for any other target either -
     * so a large image asking for `ico` fails honestly. See the README.
     */
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  'png-image': {
    id: 'png-image',
    extension: '.png',
    mediaType: 'image/png',
    // Distinct from `png`'s label for the same reason `tables` is distinct
    // from `xlsx`: a 415 or a bad target id gets answered with a list of
    // labels, and "PNG" appearing twice in one sentence tells the reader
    // nothing about which one they wanted.
    label: 'PNG (image)',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  'jpg-image': {
    id: 'jpg-image',
    extension: '.jpg',
    mediaType: 'image/jpeg',
    label: 'JPG (image)',
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  svg: {
    id: 'svg',
    extension: '.svg',
    mediaType: 'image/svg+xml',
    label: 'SVG',
    // `direct`, one Draw export filter, exactly like `pdf`'s own `draw`
    // filter - verified by hand against a real PDF AND a real PNG
    // (`draw_svg_Export`, the same filter id `soffice`'s own log line names
    // for both). Only `draw` is listed: every source that reaches this
    // target opens as a Draw document in this pipeline (`.pdf`/`.png`/
    // `.jpg`/`.jpeg`), so there is nothing to verify for a family that
    // cannot reach it in the first place.
    mode: 'direct',
    multiple: false,
    filters: { draw: 'draw_svg_Export' },
  },
  heic: {
    id: 'heic',
    extension: '.heic',
    mediaType: 'image/heic',
    label: 'HEIC',
    mode: 'heif',
    multiple: false,
    filters: {},
  },
  heif: {
    id: 'heif',
    extension: '.heif',
    mediaType: 'image/heif',
    label: 'HEIF',
    mode: 'heif',
    multiple: false,
    filters: {},
  },
  emf: {
    id: 'emf',
    extension: '.emf',
    mediaType: 'image/emf',
    label: 'EMF',
    // `direct`, same Draw route as `svg` - verified by hand against a real
    // SVG (`draw_emf_Export`, and the reverse `draw_emf_Import` reads a real
    // EMF back into a PNG).
    mode: 'direct',
    multiple: false,
    filters: { draw: 'draw_emf_Export' },
  },
  wmf: {
    id: 'wmf',
    extension: '.wmf',
    mediaType: 'image/wmf',
    label: 'WMF',
    // Same as `emf` above - verified by hand both directions.
    mode: 'direct',
    multiple: false,
    filters: { draw: 'draw_wmf_Export' },
  },
  eps: {
    id: 'eps',
    extension: '.eps',
    mediaType: 'application/postscript',
    label: 'EPS',
    // Same as `emf`/`wmf` above - verified by hand both directions.
    mode: 'direct',
    multiple: false,
    filters: { draw: 'draw_eps_Export' },
  },
  jxl: {
    id: 'jxl',
    extension: '.jxl',
    mediaType: 'image/jxl',
    label: 'JXL',
    // `ffmpeg`, the same `TRANSCODE_TARGETS` route `bmp`/`gif`/etc already
    // use - verified by hand both directions against this build's
    // `--enable-libjxl`. UNVERIFIED against Debian's own `ffmpeg` package -
    // see the Dockerfile's own comment above `libheif-examples`.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  jp2: {
    id: 'jp2',
    extension: '.jp2',
    mediaType: 'image/jp2',
    label: 'JPEG 2000',
    // Same route as `jxl` above - verified by hand both directions against
    // this build's `--enable-libopenjpeg`, same Debian caveat.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  qoi: {
    id: 'qoi',
    extension: '.qoi',
    mediaType: 'image/qoi',
    label: 'QOI',
    // Same route as `jxl`/`jp2` above - a native `ffmpeg` codec (no
    // `--enable-*` flag of its own), so lower risk than either of those two
    // on a different `ffmpeg` build - verified by hand both directions.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  tga: {
    id: 'tga',
    extension: '.tga',
    mediaType: 'image/x-tga',
    label: 'TGA',
    // Native `ffmpeg` codec, same low-risk footing as `qoi` - verified by
    // hand both directions.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  pcx: {
    id: 'pcx',
    extension: '.pcx',
    mediaType: 'image/x-pcx',
    label: 'PCX',
    // Native `ffmpeg` codec, same low-risk footing as `qoi`/`tga` - verified
    // by hand both directions.
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  apng: {
    id: 'apng',
    extension: '.apng',
    mediaType: 'image/apng',
    label: 'APNG',
    // Native `ffmpeg` muxer, same low-risk footing as `qoi`/`tga`/`pcx` -
    // verified by hand both directions (a still source becomes a one-frame
    // APNG, same as every other transcode target here always writes a
    // single still image, never an animation).
    mode: 'transcode',
    multiple: false,
    filters: {},
  },
  xml: {
    id: 'xml',
    extension: '.xml',
    mediaType: 'application/xml',
    label: 'XML',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  toml: {
    id: 'toml',
    extension: '.toml',
    mediaType: 'application/toml',
    label: 'TOML',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  ini: {
    id: 'ini',
    extension: '.ini',
    mediaType: 'text/plain',
    label: 'INI',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  sqlite: {
    id: 'sqlite',
    extension: '.sqlite',
    mediaType: 'application/vnd.sqlite3',
    label: 'SQLite',
    // Also `mode: 'data'`, even though it is the one member of the group
    // that is bytes rather than text - see `data.service.ts`'s own header
    // comment. `runDataPipeline` branches on the extension/id itself, not on
    // `mode`, so this needs no mode of its own the way `heic`/`heif` did.
    mode: 'data',
    multiple: false,
    filters: {},
  },
  'tar.zst': {
    id: 'tar.zst',
    extension: '.tar.zst',
    mediaType: 'application/zstd',
    label: 'TAR.ZST',
    // Same `archive` route every other archive target uses - see
    // `archive.service.ts`'s own `decompressZstd`/`createArchive` additions
    // for why this one alone needs the standalone `zstd` CLI rather than
    // `7z` itself (no Zstandard codec in this build).
    mode: 'archive',
    multiple: false,
    filters: {},
    archiveWriter: 'tar.zst',
  },
  obj: {
    id: 'obj',
    extension: '.obj',
    mediaType: 'model/obj',
    label: 'OBJ',
    // `assimp`, family-less like `heic`/`heif` - see `assimp.service.ts`.
    // Writes a companion `.mtl` alongside the requested `.obj` (verified by
    // hand, even from a source with no materials) - left behind, unread, the
    // same as any other engine's incidental output file; see
    // `assimp.service.ts`'s own header comment.
    mode: '3d',
    multiple: false,
    filters: {},
  },
  stl: {
    id: 'stl',
    extension: '.stl',
    mediaType: 'model/stl',
    label: 'STL',
    mode: '3d',
    multiple: false,
    filters: {},
  },
  ply: {
    id: 'ply',
    extension: '.ply',
    mediaType: 'model/ply',
    label: 'PLY',
    mode: '3d',
    multiple: false,
    filters: {},
  },
  glb: {
    id: 'glb',
    extension: '.glb',
    mediaType: 'model/gltf-binary',
    label: 'GLB',
    mode: '3d',
    multiple: false,
    filters: {},
  },
  '3mf': {
    id: '3mf',
    extension: '.3mf',
    mediaType: 'model/3mf',
    label: '3MF',
    mode: '3d',
    multiple: false,
    filters: {},
  },
  mobi: {
    id: 'mobi',
    extension: '.mobi',
    mediaType: 'application/x-mobipocket-ebook',
    label: 'MOBI',
    // `ebook-convert`, family-less like `heic`/`heif` - see
    // `ebook.service.ts`.
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  azw3: {
    id: 'azw3',
    extension: '.azw3',
    mediaType: 'application/vnd.amazon.mobi8-ebook',
    label: 'AZW3',
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  fb2: {
    id: 'fb2',
    extension: '.fb2',
    mediaType: 'application/x-fictionbook+xml',
    label: 'FB2',
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  lrf: {
    id: 'lrf',
    extension: '.lrf',
    mediaType: 'application/x-sony-bbeb',
    label: 'LRF',
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  pdb: {
    id: 'pdb',
    extension: '.pdb',
    mediaType: 'application/x-pilot',
    label: 'PDB',
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  snb: {
    id: 'snb',
    extension: '.snb',
    mediaType: 'application/x-snb',
    label: 'SNB',
    // Write-only in this build - see `ebook.service.ts`'s own header comment
    // for the real bug that makes reading it back untrustworthy (no source
    // extension `.snb` exists in `AllowedExtension` at all, the same
    // asymmetric shape `.rar` has in the other direction elsewhere in this
    // service).
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  kepub: {
    id: 'kepub',
    // The literal double extension Calibre's KEPUB writer plugin requires
    // on the OUTPUT path - see `ebook.service.ts`'s own header comment. Same
    // shape `tar.gz`/`tar.bz2`/`tar.zst` already use for a genuinely
    // two-part extension.
    extension: '.kepub.epub',
    mediaType: 'application/epub+zip',
    label: 'KEPUB',
    mode: 'ebook',
    multiple: false,
    filters: {},
  },
  ttf: {
    id: 'ttf',
    extension: '.ttf',
    mediaType: 'font/ttf',
    label: 'TTF',
    // `font_engine.py` (`fontTools`), family-less like `heic`/`heif` - see
    // `font.service.ts`.
    mode: 'font',
    multiple: false,
    filters: {},
  },
  otf: {
    id: 'otf',
    extension: '.otf',
    mediaType: 'font/otf',
    label: 'OTF',
    mode: 'font',
    multiple: false,
    filters: {},
  },
  woff: {
    id: 'woff',
    extension: '.woff',
    mediaType: 'font/woff',
    label: 'WOFF',
    mode: 'font',
    multiple: false,
    filters: {},
  },
  woff2: {
    id: 'woff2',
    extension: '.woff2',
    mediaType: 'font/woff2',
    label: 'WOFF2',
    mode: 'font',
    multiple: false,
    filters: {},
  },
  parquet: {
    id: 'parquet',
    extension: '.parquet',
    mediaType: 'application/vnd.apache.parquet',
    label: 'Parquet',
    // Also `mode: 'data'`, even though it needs a real subprocess where the
    // rest of that group does not - see `ARROW_TARGETS`'s own comment and
    // `arrow.service.ts`.
    mode: 'data',
    multiple: false,
    filters: {},
  },
  orc: {
    id: 'orc',
    extension: '.orc',
    mediaType: 'application/x-orc',
    label: 'ORC',
    mode: 'data',
    multiple: false,
    filters: {},
  },
  feather: {
    id: 'feather',
    extension: '.feather',
    mediaType: 'application/vnd.apache.arrow.file',
    label: 'Feather',
    mode: 'data',
    multiple: false,
    filters: {},
  },
};

export interface SourceFormat {
  extension: AllowedExtension;
  /**
   * The LibreOffice family that handles this file, when one does.
   *
   * Absent for a source LibreOffice cannot open at all - `.psd` today - which
   * is only possible because the target it reaches, `layers`, reads the
   * document itself and never hands it to soffice. `validateMatrix` enforces
   * exactly that: a source with no family may advertise only extract targets,
   * and a source with a family must have something for it to convert. Adding
   * `family` to a source is therefore a statement that soffice handles it, and
   * the build fails if the rest of the matrix disagrees.
   */
  family?: DocumentFamily;
  /** Media type soffice would call it, for `GET /formats`. */
  mediaType: string;
  /**
   * The LibreOffice import filter this extension implies.
   *
   * Informational only - soffice infers the filter from the extension of the
   * file it is handed, and we never pass an import filter on the command line.
   * It is recorded so the whole mapping stays auditable in one place.
   *
   * Absent in the same case `family` is: soffice never opens this file, so
   * there is no filter for it to infer.
   */
  importFilter?: string;
  /** What this source can become, in the order it should be advertised. */
  targets: readonly TargetId[];
}

/**
 * The inputs we accept, keyed by extension.
 *
 * `.html` and `.htm` are separate keys rather than a normalised one because the
 * extension is what soffice reads off the disk, so both spellings have to exist
 * as real files for either to import correctly.
 */
export const SOURCES: Readonly<Record<AllowedExtension, SourceFormat>> = {
  '.docx': {
    extension: '.docx',
    family: 'writer',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    importFilter: 'MS Word 2007 XML',
    // `tables` is the one target here that LibreOffice does not produce: the
    // document is opened as the ZIP it is and its tables are read out. It sits
    // last because it is the only lossy member of an otherwise faithful list.
    targets: ['pdf', 'odt', 'txt', 'html', 'rtf', 'epub', 'tables'],
  },
  '.docm': {
    extension: '.docm',
    family: 'writer',
    mediaType: 'application/vnd.ms-word.document.macroEnabled.12',
    importFilter: 'MS Word 2007 XML',
    // A .docm is the same OOXML package as a .docx with macros alongside it,
    // so the table extractor reads it unchanged. `.doc` deliberately does NOT
    // get this target: same family, same audience, but a binary container that
    // has to go through LibreOffice rather than through a ZIP reader.
    targets: ['pdf', 'docx', 'odt', 'txt', 'html', 'rtf', 'epub', 'tables'],
  },
  '.doc': {
    extension: '.doc',
    family: 'writer',
    mediaType: 'application/msword',
    importFilter: 'MS Word 97',
    // `docx` upgrades a legacy binary document to the modern OOXML package
    // through the same `writer` filter every other Word source already
    // uses - verified by hand (`soffice --convert-to docx:"MS Word 2007
    // XML"` against a real `.doc`), not a new filter, just an existing one
    // this source had not been given yet.
    targets: ['pdf', 'docx', 'odt', 'txt', 'html', 'rtf', 'epub'],
  },
  '.dot': {
    extension: '.dot',
    family: 'writer',
    mediaType: 'application/msword',
    importFilter: 'MS Word 97 Vorlage',
    // A Word template: the same binary container as `.doc`, so it gets the
    // same target list - no `tables`, for the same reason `.doc` has none.
    targets: ['pdf', 'docx', 'odt', 'txt', 'html', 'rtf', 'epub'],
  },
  '.dotx': {
    extension: '.dotx',
    family: 'writer',
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    importFilter: 'MS Word 2007 XML Template',
    // OOXML like `.docx`, but `tables` stays off: nothing has verified the
    // extractor against a real template's `word/document.xml`, and adding it
    // speculatively is exactly what this codebase's own rules warn against.
    targets: ['pdf', 'docx', 'odt', 'txt', 'html', 'rtf', 'epub'],
  },
  '.odt': {
    extension: '.odt',
    family: 'writer',
    mediaType: 'application/vnd.oasis.opendocument.text',
    importFilter: 'writer8',
    // Every other Writer export this family offers, not just the two that
    // used to be here - `txt`/`html`/`rtf`/`epub` use the exact same
    // per-family filters every other `writer` source already relies on
    // (verified by hand against a real ODT for each one), so withholding
    // them from ODT specifically was an omission, not a deliberate limit.
    targets: ['pdf', 'docx', 'txt', 'html', 'rtf', 'epub'],
  },
  '.ods': {
    extension: '.ods',
    family: 'calc',
    mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
    importFilter: 'calc8',
    // `html`/`csv` use the same `calc` filters `.xlsx`/`.xls`/`.xlsm` already
    // use - verified by hand against a real ODS - so ODS lacking them was
    // the same kind of omission `.odt` had for `txt`/`html`/`rtf`/`epub`.
    targets: ['pdf', 'xlsx', 'html', 'csv'],
  },
  '.odg': {
    extension: '.odg',
    family: 'draw',
    mediaType: 'application/vnd.oasis.opendocument.graphics',
    importFilter: 'draw8',
    // PDF only. The raster pipeline (`png`/`jpg`) is reserved for sources with
    // actual pages - a presentation, or a PDF that already is one - which is
    // an invariant `test/unit.test.ts` pins down; a single-canvas drawing does
    // not fit that promise, so it gets the one Draw export that does apply.
    targets: ['pdf'],
  },
  '.odp': {
    extension: '.odp',
    family: 'impress',
    mediaType: 'application/vnd.oasis.opendocument.presentation',
    importFilter: 'impress8',
    // The image targets are offered here as well as from .pptx, because the two
    // are the same kind of document and the pipeline behind them is identical:
    // render to PDF, then split the pages. There is no reason a person holding
    // a LibreOffice-native deck should be told "no" that a PowerPoint user is
    // not, and the asymmetry would be an artefact of the matrix rather than of
    // anything the conversion engine cares about.
    targets: ['pdf', 'pptx', 'png', 'jpg'],
  },
  '.xlsx': {
    extension: '.xlsx',
    family: 'calc',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    importFilter: 'Calc MS Excel 2007 XML',
    targets: ['pdf', 'ods', 'csv', 'html'],
  },
  '.xls': {
    extension: '.xls',
    family: 'calc',
    mediaType: 'application/vnd.ms-excel',
    importFilter: 'MS Excel 97',
    // `xlsx` upgrades a legacy binary workbook to the modern OOXML package
    // through the same `calc` filter every other Excel source already
    // uses - verified by hand against a real `.xls`, the same standard
    // `.doc` -> `docx` above was held to.
    targets: ['pdf', 'xlsx', 'ods', 'csv', 'html'],
  },
  '.xlsm': {
    extension: '.xlsm',
    family: 'calc',
    mediaType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    importFilter: 'Calc MS Excel 2007 XML',
    targets: ['pdf', 'xlsx', 'ods', 'csv', 'html'],
  },
  '.pptx': {
    extension: '.pptx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    importFilter: 'Impress MS PowerPoint 2007 XML',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.ppt': {
    extension: '.ppt',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint',
    importFilter: 'MS PowerPoint 97',
    // `pptx` upgrades a legacy binary deck to the modern OOXML package
    // through the same `impress` filter every other PowerPoint source
    // already uses - verified by hand against a real `.ppt`.
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.pptm': {
    extension: '.pptm',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    importFilter: 'Impress MS PowerPoint 2007 XML',
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.pps': {
    extension: '.pps',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint',
    importFilter: 'MS PowerPoint 97 AutoPlay',
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.ppsx': {
    extension: '.ppsx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    importFilter: 'Impress Office Open XML AutoPlay',
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.pot': {
    extension: '.pot',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint',
    importFilter: 'MS PowerPoint 97 Vorlage',
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.potx': {
    extension: '.potx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    importFilter: 'Impress MS PowerPoint 2007 XML Template',
    targets: ['pdf', 'pptx', 'odp', 'png', 'jpg'],
  },
  '.csv': {
    extension: '.csv',
    family: 'calc',
    mediaType: 'text/csv',
    importFilter: 'Text - txt - csv (StarCalc)',
    // `xlsx`/`ods`/`pdf`/`html` via LibreOffice (unchanged); `DATA_TARGETS`
    // via `data.service.ts` - the same family-less source can reach targets
    // through two different engines, exactly as `.pdf` reaches `pdfa` via
    // Draw and `docx` via `pdf_engine.py`.
    targets: ['xlsx', 'ods', 'pdf', 'html', ...DATA_TARGETS],
  },
  '.txt': {
    extension: '.txt',
    family: 'writer',
    mediaType: 'text/plain',
    importFilter: 'Text',
    targets: ['pdf', 'docx', 'odt', 'html', 'rtf', 'epub'],
  },
  '.html': {
    extension: '.html',
    family: 'writer',
    mediaType: 'text/html',
    importFilter: 'HTML (StarWriter)',
    targets: ['pdf', 'docx', 'odt', 'txt', 'rtf', 'epub'],
  },
  '.htm': {
    extension: '.htm',
    family: 'writer',
    mediaType: 'text/html',
    importFilter: 'HTML (StarWriter)',
    targets: ['pdf', 'docx', 'odt', 'txt', 'rtf', 'epub'],
  },
  '.rtf': {
    extension: '.rtf',
    family: 'writer',
    mediaType: 'application/rtf',
    importFilter: 'Rich Text Format',
    targets: ['docx', 'pdf', 'odt', 'txt', 'html', 'epub'],
  },
  '.png': {
    extension: '.png',
    family: 'draw',
    mediaType: 'image/png',
    importFilter: 'draw_png_Import',
    // `pdf`/`svg` via the Draw family (soffice), the rest via `ffmpeg` - two
    // engines, one source, exactly like `.pdf` itself reaches `pdfa`/`png`/
    // `jpg` through Draw and `docx`/`pptx`/`xlsx`/`markdown` through a
    // second engine entirely. `svg` export verified by hand against a real
    // PNG (`draw_svg_Export`, same as `.pdf`'s own). `png-image` is
    // excluded: a PNG "converting" to a single PNG is not a conversion this
    // service should advertise.
    targets: [
      'pdf',
      'svg',
      'emf',
      'wmf',
      'eps',
      ...TRANSCODE_TARGETS.filter((id) => id !== 'png-image'),
      ...HEIF_TARGETS,
    ],
  },
  '.jpg': {
    extension: '.jpg',
    family: 'draw',
    mediaType: 'image/jpeg',
    importFilter: 'draw_jpg_Import',
    // Same exclusion as `.png` above, for `jpg-image` this time. `svg`/
    // `emf`/`wmf`/`eps` reach this source the same way they reach `.png` -
    // same family, same Draw export filters.
    targets: [
      'pdf',
      'svg',
      'emf',
      'wmf',
      'eps',
      ...TRANSCODE_TARGETS.filter((id) => id !== 'jpg-image'),
      ...HEIF_TARGETS,
    ],
  },
  '.jpeg': {
    extension: '.jpeg',
    family: 'draw',
    mediaType: 'image/jpeg',
    importFilter: 'draw_jpg_Import',
    // `.jpeg` keeps `jpg-image` in its list, unlike `.jpg` above: the two
    // extensions are the same format, but `.jpeg` -> `jpg-image` is a real
    // normalising conversion (a different spelling of the extension in, a
    // `.jpg` out) rather than a source becoming its own literal extension.
    targets: ['pdf', 'svg', 'emf', 'wmf', 'eps', ...TRANSCODE_TARGETS, ...HEIF_TARGETS],
  },
  '.psd': {
    extension: '.psd',
    mediaType: 'image/vnd.adobe.photoshop',
    // No `family` and no `importFilter`, and their absence is the point:
    // LibreOffice has no PSD support to speak of, and more to the point this
    // service never asks it for any. `layers` reads the document itself, which
    // is the whole reason a source with no document family can exist here at
    // all - see the note on `SourceFormat.family`.
    //
    // One target, deliberately. A PSD rendered by LibreOffice would be a
    // different feature with a different name, and offering `pdf` here would
    // promise a fidelity nothing in this pipeline could deliver.
    targets: ['layers'],
  },
  '.pdf': {
    extension: '.pdf',
    // Real, and deliberately the only family a PDF gets: LibreOffice opens
    // every PDF as a Draw document, verified by running `soffice
    // --convert-to` for docx/pptx/xlsx/odt/odp/ods/rtf/txt against a real PDF
    // and getting "no export filter found" for every one of them, while
    // pdf/png/jpg/svg/odg/html - Draw's own export filters - all worked. That
    // is why `pdfa` and the raster targets are `direct`/`raster` here exactly
    // as they are for any other Draw-family source, while `docx`/`pptx`/
    // `xlsx` cannot be: there is no filter for them to reach, at any mode,
    // from this family - which is exactly what their `engineFrom` route
    // exists for.
    family: 'draw',
    mediaType: 'application/pdf',
    importFilter: 'draw_pdf_Import',
    // `docx`/`pptx`/`xlsx`/`markdown` sit last because they are the only
    // reconstructive/extractive members of the list - `pdfa` and the raster
    // targets are LibreOffice's own faithful re-export of the same bytes.
    // `svg` sits with them: also a faithful Draw re-export (`draw_svg_Export`
    // - verified by hand against a real PDF), just a vector one rather than
    // a raster one. `emf`/`wmf`/`eps` are the same faithful Draw re-export
    // again - verified by hand.
    targets: ['pdfa', 'png', 'jpg', 'svg', 'emf', 'wmf', 'eps', 'docx', 'pptx', 'xlsx', 'markdown'],
  },
  '.md': {
    extension: '.md',
    // No `family`: pandoc, not LibreOffice, reads every source in this
    // group - see the note on `.psd` above for why a source with no family
    // is possible at all, and `pandoc.service.ts` for the engine itself.
    mediaType: 'text/markdown',
    // `markdown` is excluded (see the target's own `engineFrom` comment): a
    // `.md` file "converting" to Markdown is not a conversion to offer.
    targets: ['docx', 'html', 'odt', 'rtf', 'txt'],
  },
  '.rst': {
    extension: '.rst',
    mediaType: 'text/x-rst',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.tex': {
    extension: '.tex',
    mediaType: 'application/x-tex',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.textile': {
    extension: '.textile',
    mediaType: 'text/x-textile',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.org': {
    extension: '.org',
    mediaType: 'text/org',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.opml': {
    extension: '.opml',
    mediaType: 'text/x-opml',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.muse': {
    extension: '.muse',
    mediaType: 'text/x-muse',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.ipynb': {
    extension: '.ipynb',
    mediaType: 'application/x-ipynb+json',
    targets: ['docx', 'html', 'odt', 'rtf', 'txt', 'markdown'],
  },
  '.zip': {
    extension: '.zip',
    // No `family`: `7z`, not LibreOffice, reads every source in this group -
    // see `archive.service.ts`. `zip` itself is excluded from `targets`
    // (caught by the matrix's own self-target check, since this extension's
    // stripped form is exactly the `zip` id).
    mediaType: 'application/zip',
    targets: ['tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.tar': {
    extension: '.tar',
    mediaType: 'application/x-tar',
    targets: ['zip', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.tgz': {
    extension: '.tgz',
    mediaType: 'application/gzip',
    targets: ['zip', 'tar', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.tbz2': {
    extension: '.tbz2',
    mediaType: 'application/x-bzip2',
    targets: ['zip', 'tar', 'tar.gz', 'tar.zst', '7z', 'cbz'],
  },
  '.txz': {
    extension: '.txz',
    mediaType: 'application/x-xz',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.gz': {
    extension: '.gz',
    mediaType: 'application/gzip',
    // A bare `.gz` (one compressed file, not a tarball) offers the same
    // targets as every other archive source: `archive.service.ts`'s
    // extraction is generic over "how many files came out", not specific to
    // tar's own container shape.
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.bz2': {
    extension: '.bz2',
    mediaType: 'application/x-bzip2',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.xz': {
    extension: '.xz',
    mediaType: 'application/x-xz',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.zst': {
    extension: '.zst',
    // `zstd` undoes the outer compression layer, not `7z` - `7z` has no
    // Zstandard codec in this build at all (verified by hand: `7z l` on a
    // real `.zst` file fails with "Unsupported archive type"). See
    // `conversion.service.ts`'s `runArchivePipeline` for the pre-decompress
    // step this needs that every other archive source here does not, and
    // `archive.service.ts`'s `decompressZstd`.
    mediaType: 'application/zstd',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', '7z', 'cbz'],
  },
  '.7z': {
    extension: '.7z',
    mediaType: 'application/x-7z-compressed',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', 'cbz'],
  },
  '.iso': {
    extension: '.iso',
    mediaType: 'application/x-iso9660-image',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z', 'cbz'],
  },
  '.cbz': {
    extension: '.cbz',
    // A CBZ is a plain ZIP under a comic-reader extension - same engine,
    // same validation, as every other archive source. Excludes `cbz` itself
    // (self-target check) but otherwise offers exactly what `.zip` does.
    mediaType: 'application/vnd.comicbook+zip',
    targets: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.zst', '7z'],
  },
  '.bmp': {
    extension: '.bmp',
    // No `family`: `ffmpeg`, not LibreOffice, reads every source in this
    // group - see `ffmpeg.service.ts`. Each one's own target list is every
    // OTHER transcode target, filtered explicitly rather than left to
    // `validateMatrix`'s self-target check to catch: the check exists as a
    // backstop for a mistake, not as the intended way to read what a format
    // becomes.
    mediaType: 'image/bmp',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'bmp'), ...HEIF_TARGETS],
  },
  '.gif': {
    extension: '.gif',
    mediaType: 'image/gif',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'gif'), ...HEIF_TARGETS],
  },
  '.tiff': {
    extension: '.tiff',
    mediaType: 'image/tiff',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'tiff'), ...HEIF_TARGETS],
  },
  '.webp': {
    extension: '.webp',
    mediaType: 'image/webp',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'webp'), ...HEIF_TARGETS],
  },
  '.avif': {
    extension: '.avif',
    mediaType: 'image/avif',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'avif'), ...HEIF_TARGETS],
  },
  '.ico': {
    extension: '.ico',
    mediaType: 'image/x-icon',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'ico'), ...HEIF_TARGETS],
  },
  '.jxl': {
    extension: '.jxl',
    // No `family`, same as `.bmp`/`.gif`/etc above - `ffmpeg`'s own
    // `--enable-libjxl` reads and writes this one, verified by hand. See
    // `jxl`'s own TARGETS entry for the Debian-build caveat.
    mediaType: 'image/jxl',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'jxl'), ...HEIF_TARGETS],
  },
  '.jp2': {
    extension: '.jp2',
    mediaType: 'image/jp2',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'jp2'), ...HEIF_TARGETS],
  },
  '.qoi': {
    extension: '.qoi',
    mediaType: 'image/qoi',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'qoi'), ...HEIF_TARGETS],
  },
  '.tga': {
    extension: '.tga',
    mediaType: 'image/x-tga',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'tga'), ...HEIF_TARGETS],
  },
  '.pcx': {
    extension: '.pcx',
    mediaType: 'image/x-pcx',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'pcx'), ...HEIF_TARGETS],
  },
  '.apng': {
    extension: '.apng',
    mediaType: 'image/apng',
    targets: [...TRANSCODE_TARGETS.filter((id) => id !== 'apng'), ...HEIF_TARGETS],
  },
  '.srt': {
    extension: '.srt',
    // No `family`: `ffmpeg`, not LibreOffice, reads every source in this
    // group - see the note above `SUBTITLE_TRANSCODE_TARGETS`.
    mediaType: 'application/x-subrip',
    targets: SUBTITLE_TRANSCODE_TARGETS.filter((id) => id !== 'srt'),
  },
  '.vtt': {
    extension: '.vtt',
    mediaType: 'text/vtt',
    targets: SUBTITLE_TRANSCODE_TARGETS.filter((id) => id !== 'vtt'),
  },
  '.ass': {
    extension: '.ass',
    mediaType: 'text/x-ass',
    targets: SUBTITLE_TRANSCODE_TARGETS.filter((id) => id !== 'ass'),
  },
  '.ssa': {
    extension: '.ssa',
    mediaType: 'text/x-ssa',
    targets: SUBTITLE_TRANSCODE_TARGETS.filter((id) => id !== 'ssa'),
  },
  '.tsv': {
    extension: '.tsv',
    // No `family`: `data.service.ts`, not LibreOffice, reads every source in
    // this group - see the note above `DATA_TARGETS`. `csv` is included
    // alongside the `DATA_TARGETS` ids because it reaches this source
    // through `TARGETS.csv`'s own `engineFrom.data`, not through `mode:
    // 'data'` - `resolveConversion` treats the two identically from here.
    mediaType: 'text/tab-separated-values',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'tsv')],
  },
  '.json': {
    extension: '.json',
    mediaType: 'application/json',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'json')],
  },
  '.yaml': {
    extension: '.yaml',
    mediaType: 'application/yaml',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'yaml')],
  },
  '.yml': {
    extension: '.yml',
    // The same format as `.yaml` under its other common spelling - same
    // reasoning as `.html`/`.htm` for why both exist as real, separate
    // keys: soffice/this engine reads the file soffice was handed, and
    // both spellings have to exist as real files for either to work.
    mediaType: 'application/yaml',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'yaml')],
  },
  '.jsonl': {
    extension: '.jsonl',
    mediaType: 'application/jsonl',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'jsonl')],
  },
  '.xml': {
    extension: '.xml',
    // No `family`: `xml-js`, not LibreOffice, reads this source - see
    // `data.service.ts`.
    mediaType: 'application/xml',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'xml')],
  },
  '.toml': {
    extension: '.toml',
    // No `family`: `smol-toml` reads this source - see `data.service.ts`.
    mediaType: 'application/toml',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'toml')],
  },
  '.ini': {
    extension: '.ini',
    // No `family`: `ini` reads this source - see `data.service.ts`.
    mediaType: 'text/plain',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'ini')],
  },
  '.sqlite': {
    extension: '.sqlite',
    // No `family`: `node:sqlite`'s `DatabaseSync` reads this source - the
    // one member of the data-engine group that is bytes, not text - see
    // `data.service.ts`'s own header comment.
    mediaType: 'application/vnd.sqlite3',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'sqlite')],
  },
  '.svg': {
    extension: '.svg',
    // A real family, unlike `.bmp`/`.gif`/etc: LibreOffice opens an SVG as a
    // Draw document directly - verified by hand (`draw_png_Export`/
    // `draw_pdf_Export` both ran against a real `.svg` file and produced a
    // correct PNG/PDF). `ffmpeg` ALSO reads `.svg` (this build's `librsvg`
    // decoder, verified by hand), which is what lets it reach
    // `TRANSCODE_TARGETS`/`HEIF_TARGETS` below the same flat way every other
    // image source does - the `family`/`importFilter` here only cover its
    // `pdf`/`svg` reach through Draw.
    family: 'draw',
    mediaType: 'image/svg+xml',
    importFilter: 'draw_svg_Import',
    // `svg` itself is excluded (self-target check - `.svg` converting to
    // `svg` is not a conversion this service should advertise). `emf`/`wmf`/
    // `eps` reach it the same Draw route `pdf`/`svg` do - verified by hand.
    targets: ['pdf', 'emf', 'wmf', 'eps', ...TRANSCODE_TARGETS, ...HEIF_TARGETS],
  },
  '.emf': {
    extension: '.emf',
    // Same Draw route as `.svg` above - verified by hand both directions
    // (`draw_emf_Export`/`draw_emf_Import` against a real file). No
    // `TRANSCODE_TARGETS`/`HEIF_TARGETS` reach: unlike `.svg`, `ffmpeg` does
    // not decode EMF at all, so those routes simply are not there for this
    // source the way they are for `.svg`. `png`/`jpg` are deliberately
    // EXCLUDED too, unlike `.svg`/`.png`/`.jpg` above: those are `raster`
    // targets, reserved for sources with actual pages to split one image
    // per page from (a presentation, or a PDF - see `routes only
    // presentations and PDFs to the raster pipeline` in `test/unit.test.ts`)
    // - a single-page EMF has no `png-image`/`jpg-image`-shaped single-file
    // route to reach either one through, the way a `TRANSCODE_TARGETS`
    // source does, so it reaches neither.
    family: 'draw',
    mediaType: 'image/emf',
    importFilter: 'draw_emf_Import',
    targets: ['pdf', 'svg', 'wmf', 'eps'],
  },
  '.wmf': {
    extension: '.wmf',
    // Same as `.emf` above, including the `png`/`jpg` exclusion - verified
    // by hand both directions.
    family: 'draw',
    mediaType: 'image/wmf',
    importFilter: 'draw_wmf_Import',
    targets: ['pdf', 'svg', 'emf', 'eps'],
  },
  '.eps': {
    extension: '.eps',
    // Same as `.emf`/`.wmf` above, including the `png`/`jpg` exclusion -
    // verified by hand both directions.
    family: 'draw',
    mediaType: 'application/postscript',
    importFilter: 'draw_eps_Import',
    targets: ['pdf', 'svg', 'emf', 'wmf'],
  },
  '.heic': {
    extension: '.heic',
    // No `family`: `libheif`'s own tools, not LibreOffice, read this source
    // - see `heif.service.ts` and `TargetFormat.mode`'s own `heif` bullet.
    mediaType: 'image/heic',
    // `heif` itself is excluded (self-target check would catch `heic`
    // anyway, but `heif` needs excluding explicitly - the two are different
    // ids for the same underlying container, and converting one to the
    // other is a real, if minor, normalisation this service does offer).
    targets: [...TRANSCODE_TARGETS, 'heif'],
  },
  '.heif': {
    extension: '.heif',
    mediaType: 'image/heif',
    targets: [...TRANSCODE_TARGETS, 'heic'],
  },
  '.obj': {
    extension: '.obj',
    // No `family`: `assimp`, not LibreOffice, reads every source in this
    // group - see `assimp.service.ts`.
    mediaType: 'model/obj',
    targets: ASSIMP_TARGETS.filter((id) => id !== 'obj'),
  },
  '.stl': {
    extension: '.stl',
    mediaType: 'model/stl',
    targets: ASSIMP_TARGETS.filter((id) => id !== 'stl'),
  },
  '.ply': {
    extension: '.ply',
    mediaType: 'model/ply',
    targets: ASSIMP_TARGETS.filter((id) => id !== 'ply'),
  },
  '.glb': {
    extension: '.glb',
    mediaType: 'model/gltf-binary',
    targets: ASSIMP_TARGETS.filter((id) => id !== 'glb'),
  },
  '.3mf': {
    extension: '.3mf',
    mediaType: 'model/3mf',
    targets: ASSIMP_TARGETS.filter((id) => id !== '3mf'),
  },
  '.off': {
    extension: '.off',
    // A real, verified SOURCE (`assimp listext` reads it) with no target of
    // its own to exclude - see `ASSIMP_TARGETS`'s own comment for why `.off`
    // itself never appears in that list.
    mediaType: 'model/vnd.off',
    targets: ASSIMP_TARGETS,
  },
  '.epub': {
    extension: '.epub',
    // No `family`: `ebook-convert`, not LibreOffice, reads this source - see
    // `ebook.service.ts`. A `.kepub.epub` upload is a real EPUB container
    // underneath (verified by hand), so it is read here too, under its own
    // `extname()`-truncated `.epub` bucket, exactly like `.tar.gz` already
    // reads as `.gz` elsewhere in this matrix.
    mediaType: 'application/epub+zip',
    targets: EBOOK_TARGETS,
  },
  '.mobi': {
    extension: '.mobi',
    mediaType: 'application/x-mobipocket-ebook',
    targets: ['epub', ...EBOOK_TARGETS.filter((id) => id !== 'mobi')],
  },
  '.azw3': {
    extension: '.azw3',
    mediaType: 'application/vnd.amazon.mobi8-ebook',
    targets: ['epub', ...EBOOK_TARGETS.filter((id) => id !== 'azw3')],
  },
  '.fb2': {
    extension: '.fb2',
    mediaType: 'application/x-fictionbook+xml',
    targets: ['epub', ...EBOOK_TARGETS.filter((id) => id !== 'fb2')],
  },
  '.lrf': {
    extension: '.lrf',
    mediaType: 'application/x-sony-bbeb',
    targets: ['epub', ...EBOOK_TARGETS.filter((id) => id !== 'lrf')],
  },
  '.pdb': {
    extension: '.pdb',
    mediaType: 'application/x-pilot',
    targets: ['epub', ...EBOOK_TARGETS.filter((id) => id !== 'pdb')],
  },
  '.ttf': {
    extension: '.ttf',
    // No `family`: `fontTools`, not LibreOffice, reads every source in this
    // group - see `font.service.ts`.
    mediaType: 'font/ttf',
    targets: FONT_TARGETS.filter((id) => id !== 'ttf'),
  },
  '.otf': {
    extension: '.otf',
    mediaType: 'font/otf',
    targets: FONT_TARGETS.filter((id) => id !== 'otf'),
  },
  '.woff': {
    extension: '.woff',
    mediaType: 'font/woff',
    targets: FONT_TARGETS.filter((id) => id !== 'woff'),
  },
  '.woff2': {
    extension: '.woff2',
    mediaType: 'font/woff2',
    targets: FONT_TARGETS.filter((id) => id !== 'woff2'),
  },
  '.parquet': {
    extension: '.parquet',
    // No `family`: `arrow_engine.py` (`pyarrow`), not LibreOffice, reads
    // this source - see `arrow.service.ts`.
    mediaType: 'application/vnd.apache.parquet',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'parquet')],
  },
  '.orc': {
    extension: '.orc',
    mediaType: 'application/x-orc',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'orc')],
  },
  '.feather': {
    extension: '.feather',
    mediaType: 'application/vnd.apache.arrow.file',
    targets: ['csv', ...DATA_TARGETS.filter((id) => id !== 'feather')],
  },
  '.eml': {
    extension: '.eml',
    // No `family`: `mailparser`, not LibreOffice, reads this source - see
    // `email.service.ts`. Only `txt`/`html` - the EXISTING ids, reached
    // through `engineFrom.email` on each, not a mode of its own.
    mediaType: 'message/rfc822',
    targets: ['txt', 'html'],
  },
};

export const ALLOWED_EXTENSIONS = Object.keys(SOURCES) as AllowedExtension[];

export const TARGET_IDS = Object.keys(TARGETS) as TargetId[];

/**
 * Prototype-safe membership tests.
 *
 * `hasOwnProperty` rather than `in` or a truthiness check on the lookup: these
 * tables are plain objects, so `SOURCES['constructor']` and `TARGETS['toString']`
 * would otherwise resolve to inherited functions and sail straight through a
 * check that only tested the value.
 */
export function isAllowedExtension(ext: string): ext is AllowedExtension {
  return Object.prototype.hasOwnProperty.call(SOURCES, ext);
}

export function isTargetId(id: string): id is TargetId {
  return Object.prototype.hasOwnProperty.call(TARGETS, id);
}

export interface ResolvedConversion {
  source: SourceFormat;
  target: TargetFormat;
  /**
   * The `--convert-to` argument for a `direct` target reached through
   * `filters`.
   *
   * Empty for a `raster` target, which is rendered to PDF first and then
   * rasterised - the caller uses `pdfFilterFor()` for that first step - and
   * empty for an engine pair, which never touches soffice at all.
   */
  convertTo: string;
  /**
   * Which engine produces this PAIR - `'soffice'` for everything `filters`/
   * `mode: 'raster'` describes, `'extract'` for the two targets that read
   * the upload's own bytes, or the name of the non-LibreOffice engine named
   * in `target.engineFrom`.
   *
   * A property of the PAIR, not of the target: `target.mode` for `docx` is
   * `'direct'`, and stays `'direct'`, because that is how every OTHER source
   * reaches it - a `.doc` upload asking for `docx` still gets a plain
   * `soffice --convert-to`. Only a PDF's or a markup file's request for
   * `docx` takes an engine route, which is exactly what `target.engineFrom`
   * names. The caller (`conversion.service.ts`) checks this before falling
   * back to `target.mode`, so it never has to ask "but which route did THIS
   * one take" any other way.
   */
  engine:
    | 'soffice'
    | 'extract'
    | 'pdf-engine'
    | 'pandoc'
    | 'archive'
    | 'ffmpeg'
    | 'data'
    | 'heif'
    | 'assimp'
    | 'ebook'
    | 'font'
    | 'email';
}

/**
 * Is this source/target pair one we actually support?
 *
 * Returns `null` rather than throwing so callers can tell the two failure modes
 * apart: an unknown target id is a 404 (the address does not exist), while a
 * known target the source cannot become is a 415 (the address exists, this
 * document cannot go there).
 */
export function resolveConversion(
  extension: AllowedExtension,
  targetId: TargetId,
): ResolvedConversion | null {
  const source = SOURCES[extension];
  const target = TARGETS[targetId];
  if (!source.targets.includes(targetId)) return null;

  if (target.engineFrom?.pdf?.includes(extension)) {
    // Checked before `mode`: this is a second, independent route to the same
    // target id, and it says nothing about how any OTHER source reaches it.
    // See `ResolvedConversion.engine` and the field's own doc comment.
    return { source, target, convertTo: '', engine: 'pdf-engine' };
  }
  if (target.engineFrom?.pandoc?.includes(extension)) {
    return { source, target, convertTo: '', engine: 'pandoc' };
  }
  if (target.engineFrom?.data?.includes(extension)) {
    // The other data-interchange formats reaching `csv` - see
    // `DATA_TARGETS`'s own comment for why `csv` needs this route instead
    // of `mode: 'data'` outright.
    return { source, target, convertTo: '', engine: 'data' };
  }
  if (target.engineFrom?.ebook?.includes(extension)) {
    // The ebook sources reaching `epub` - see `EBOOK_TARGETS`'s own comment
    // for why `epub` needs this route instead of `mode: 'ebook'` outright
    // (it is an EXISTING `direct` target every writer-family source already
    // reaches through LibreOffice's own filter).
    return { source, target, convertTo: '', engine: 'ebook' };
  }
  if (target.engineFrom?.email?.includes(extension)) {
    // `.eml` reaching the EXISTING `txt`/`html` targets - same second-route
    // shape as `ebook` above. See `email.service.ts`.
    return { source, target, convertTo: '', engine: 'email' };
  }

  if (target.mode === 'extract') {
    // Nothing to look up: there is no LibreOffice filter for an engine that
    // does not call LibreOffice. Whether this pair is legal has already been
    // decided by the `targets` check above, and `validateMatrix` guarantees
    // the two lists agree - so reaching here means the extractor can read this
    // source, or the matrix is broken and would have thrown at import.
    return { source, target, convertTo: '', engine: 'extract' };
  }

  if (target.mode === 'archive') {
    // Also family-less, like `extract` above - `7z`, not LibreOffice, reads
    // and writes every pair this mode covers, so there is no filter to look
    // up and no family to require.
    return { source, target, convertTo: '', engine: 'archive' };
  }

  if (target.mode === 'transcode' && (extension === '.heic' || extension === '.heif')) {
    // A `.heic`/`.heif` source reaching an ordinary `transcode` target
    // (`bmp`/`gif`/`tiff`/`webp`/`avif`/`ico`/`png-image`/`jpg-image`) still
    // cannot go through bare `ffmpeg` - this build has no HEIF decoder for
    // it to use - so this pair is routed to the `heif` engine instead,
    // BEFORE the generic `transcode` branch below would otherwise claim it.
    // See `TargetFormat.mode`'s own `heif` bullet.
    return { source, target, convertTo: '', engine: 'heif' };
  }

  if (target.mode === 'transcode') {
    // `ffmpeg` reads and writes every pair this mode covers directly - no
    // filter, and no family requirement either: a source that ALSO has a
    // family (`.png`/`.jpg`/`.jpeg`, for their `pdf` target) still reaches a
    // transcode target this way, unaffected by whatever family it has.
    return { source, target, convertTo: '', engine: 'ffmpeg' };
  }

  if (target.mode === 'heif') {
    // Also family-less like `transcode`/`data` above - `heif-convert`/
    // `heif-enc` reads and writes every pair this mode covers directly, with
    // no per-family filter to look up. See `TargetFormat.mode`'s own `heif`
    // bullet for what `heif.service.ts` actually does for each pair.
    return { source, target, convertTo: '', engine: 'heif' };
  }

  if (target.mode === '3d') {
    // Also family-less - `assimp` reads and writes every pair this mode
    // covers directly, no per-family filter to look up. See
    // `assimp.service.ts`.
    return { source, target, convertTo: '', engine: 'assimp' };
  }

  if (target.mode === 'ebook') {
    // Also family-less - `ebook-convert` reads and writes every pair this
    // mode covers directly, no per-family filter to look up. See
    // `ebook.service.ts`.
    return { source, target, convertTo: '', engine: 'ebook' };
  }

  if (target.mode === 'font') {
    // Also family-less - `font_engine.py` reads and writes every pair this
    // mode covers directly, no per-family filter to look up. See
    // `font.service.ts`.
    return { source, target, convertTo: '', engine: 'font' };
  }

  if (target.mode === 'data') {
    // Also family-less - `data.service.ts` reads and writes every pair
    // this mode covers directly, exactly like `transcode` above but with no
    // subprocess at all. `csv` the SOURCE extension reaches these targets
    // this way too (it has a family, `calc`, but that is irrelevant here -
    // this branch does not consult it, same as `transcode`'s comment above).
    return { source, target, convertTo: '', engine: 'data' };
  }

  // Everything below asks LibreOffice to do the work, so a source it cannot
  // open has nothing to offer here. Unreachable as the matrix stands -
  // `validateMatrix` refuses a family-less source that advertises anything but
  // an extract - but the guard is what keeps that a fact about the matrix
  // rather than an assumption made at the one place it would be expensive.
  if (!source.family) return null;

  if (target.mode === 'raster') {
    // A raster target is built from the family's PDF export, so a family that
    // cannot write a PDF cannot write an image either.
    if (!pdfFilterFor(source.family)) return null;
    return { source, target, convertTo: '', engine: 'soffice' };
  }

  const filter = target.filters[source.family];
  if (!filter) return null;
  return {
    source,
    target,
    convertTo: `${target.extension.slice(1)}:${filter}`,
    engine: 'soffice',
  };
}

/**
 * The PDF export filter for a family, if it has one.
 *
 * Takes an absent family as well as a present one, because the raster pipeline
 * asks this question on behalf of a source that may have no family at all. Its
 * honest answer then is "no filter", which the caller already knows how to
 * handle - and which is the same answer it gives for a family that has no PDF
 * export.
 */
export function pdfFilterFor(family: DocumentFamily | undefined): string | undefined {
  return family ? TARGETS.pdf.filters[family] : undefined;
}

/**
 * Does this target answer with a ZIP of several files rather than one file?
 *
 * A function in this file rather than a comparison written where it is needed,
 * because two callers need the same answer and they disagreeing is a
 * client-visible fault rather than a cosmetic one: the response body describes
 * itself as an archive at `GET /formats` (`multiple`) and is actually sent as
 * one in the controller. If those two ever disagreed, a client would unwrap a
 * body that is not a ZIP - or read a ZIP as a document - and fail somewhere
 * far from the cause.
 *
 * The answer is now the target's own declaration rather than a rule about its
 * mode. It used to be `mode === 'raster'`, which was a fine way of saying it
 * while every raster target archived and nothing else did. `layers` ended that:
 * it is an extract, like `tables`, and answers with one file per layer rather
 * than the one workbook `tables` produces. The two facts were never the same
 * fact, and this is the one that decides what a response is.
 */
export function archivesFiles(target: TargetFormat): boolean {
  return target.multiple;
}

/** Every target this extension can become, as ids. */
export function targetsFor(extension: AllowedExtension): readonly TargetId[] {
  return SOURCES[extension].targets;
}

/** "PDF, ODT, TXT" - the list as it appears inside a sentence. */
export function describeTargets(ids: readonly TargetId[]): string {
  return ids.map((id) => TARGETS[id].label).join(', ');
}

/** The extensions people actually type, for the "we do not accept that" message. */
export function describeSources(): string {
  return ALLOWED_EXTENSIONS.join(', ');
}

/**
 * Refuse to start with a matrix that contradicts itself.
 *
 * The tables above are hand-written, and every mistake in them fails softly at
 * runtime: a target listed for a family that has no filter for it would return
 * a 415 for a conversion the documentation advertises, and a typo in a target id
 * would 404 on a format we claim to support. Neither is visible without the
 * exact request that trips it.
 *
 * Throwing at import time makes that a build failure instead. It runs on the
 * first import of this module, which is every path - tests included.
 */
export function validateMatrix(): void {
  const problems: string[] = [];

  for (const [id, target] of Object.entries(TARGETS)) {
    if (id !== target.id) problems.push(`TARGETS["${id}"].id is "${target.id}"`);
    if (!target.extension.startsWith('.')) {
      problems.push(`target "${id}" has a bare extension "${target.extension}"`);
    }
    const filterCount = Object.keys(target.filters).length;
    const engineSourceCount =
      (target.engineFrom?.pdf?.length ?? 0) + (target.engineFrom?.pandoc?.length ?? 0);
    // A direct target with no filters at all is only legitimate when
    // `engineFrom` is its ENTIRE reach (`markdown`, reachable only from a
    // PDF via `pdf_engine.py` or a markup source via pandoc) - the real
    // invariant is "reachable by some mechanism", and `engineFrom` is
    // checked as its own mechanism further down, so this only has to catch a
    // target with NEITHER.
    if (target.mode === 'direct' && filterCount === 0 && engineSourceCount === 0) {
      problems.push(`direct target "${id}" declares no filters`);
    }
    if (target.mode !== 'direct' && filterCount > 0) {
      problems.push(`${target.mode} target "${id}" should not declare filters`);
    }

    // Two of the three modes fix what a response looks like, so a target that
    // disagrees with its own mode is a contradiction rather than a choice. The
    // extract targets are the one place `multiple` is free, which is exactly
    // why it stopped being derivable from `mode`.
    if (target.mode === 'raster' && !target.multiple) {
      problems.push(`raster target "${id}" does not declare itself an archive`);
    }
    if (target.mode === 'direct' && target.multiple) {
      problems.push(`direct target "${id}" declares itself an archive but writes one file`);
    }
    if (target.mode === 'archive' && target.multiple) {
      problems.push(
        `archive target "${id}" declares itself a multi-file response, but the response IS the one archive`,
      );
    }
    if (target.mode === 'archive' && !target.archiveWriter) {
      problems.push(`archive target "${id}" declares no archiveWriter`);
    }
    if (target.mode !== 'archive' && target.archiveWriter) {
      problems.push(`target "${id}" declares archiveWriter but is not an archive target`);
    }
    if (target.mode === 'transcode' && target.multiple) {
      problems.push(`transcode target "${id}" declares itself a multi-file response`);
    }
    if (target.mode === 'data' && target.multiple) {
      problems.push(`data target "${id}" declares itself a multi-file response`);
    }
    if (target.mode === 'heif' && target.multiple) {
      problems.push(`heif target "${id}" declares itself a multi-file response`);
    }
    if (target.mode === '3d' && target.multiple) {
      problems.push(`3d target "${id}" declares itself a multi-file response`);
    }
    if (target.mode === 'ebook' && target.multiple) {
      problems.push(`ebook target "${id}" declares itself a multi-file response`);
    }
    if (target.mode === 'font' && target.multiple) {
      problems.push(`font target "${id}" declares itself a multi-file response`);
    }

    if (target.mode === 'extract') {
      // An extract target names its own sources, so it is the only target
      // whose reach is not implied by `filters`. Both directions are checked:
      // a name that is not a source, and a source that does not offer it -
      // either way the matrix would advertise a conversion that cannot run.
      const named = target.extractFrom ?? [];
      if (named.length === 0) problems.push(`extract target "${id}" names no sources`);
      for (const extension of named) {
        const source = SOURCES[extension];
        if (!source) {
          problems.push(`extract target "${id}" names unknown source "${extension}"`);
        } else if (!source.targets.includes(id as TargetId)) {
          problems.push(`extract target "${id}" names "${extension}", which does not offer it`);
        }
      }
    } else if (target.extractFrom) {
      problems.push(`target "${id}" declares extractFrom but is not an extract target`);
    }

    // `engineFrom` is checked independently of `mode`, because it is a
    // second route to the SAME target id rather than a mode of its own - see
    // the field's own doc comment. Both directions matter here too: a name
    // that is not a source, and a source that does not list this id among
    // its own targets. Checked once per engine, and once more across both
    // engines together, since a source named under BOTH would leave
    // `resolveConversion` to silently pick whichever is checked first.
    const engines = ['pdf', 'pandoc', 'data', 'ebook', 'email'] as const;
    const seenUnderAnotherEngine = new Set<string>();
    for (const engine of engines) {
      for (const extension of target.engineFrom?.[engine] ?? []) {
        const source = SOURCES[extension];
        if (!source) {
          problems.push(`target "${id}" names unknown ${engine} engine source "${extension}"`);
          continue;
        }
        if (!source.targets.includes(id as TargetId)) {
          problems.push(
            `target "${id}" names ${engine} engine source "${extension}", which does not offer it`,
          );
        }
        // A source whose family already has a filter for this target would
        // make `resolveConversion` silently prefer the engine route over a
        // working LibreOffice one - never useful, and a sign the matrix means
        // something other than what it says.
        if (source.family && target.filters[source.family]) {
          problems.push(
            `target "${id}" has both a filter and a ${engine} engine route for "${extension}" - ambiguous`,
          );
        }
        if (seenUnderAnotherEngine.has(extension)) {
          problems.push(
            `target "${id}" names engine source "${extension}" under more than one engine`,
          );
        }
        seenUnderAnotherEngine.add(extension);
      }
    }
  }

  for (const [ext, source] of Object.entries(SOURCES)) {
    if (ext !== source.extension) problems.push(`SOURCES["${ext}"].extension is "${source.extension}"`);
    if (source.targets.length === 0) problems.push(`source "${ext}" can become nothing`);
    for (const targetId of source.targets) {
      if (!isTargetId(targetId)) {
        problems.push(`source "${ext}" lists unknown target "${targetId}"`);
        continue;
      }
      if (!resolveConversion(source.extension, targetId)) {
        problems.push(
          `source "${ext}" (${source.family ?? 'no family'}) advertises "${targetId}" but has no filter for it`,
        );
      }
      // The other half of the family rule below, in the direction that catches
      // a source claiming to be convertible by LibreOffice when it has also
      // said LibreOffice cannot open it. A family-less source reaching this
      // target through an engine (`.md` -> `docx` via pandoc, same as `.pdf`
      // -> `docx` via pdf_engine.py) is not that claim - `resolveConversion`
      // already proved it above - so only a target with no engine route for
      // this extension, and no `extract` route either, is actually a
      // contradiction.
      const reachesViaEngine =
        (TARGETS[targetId].engineFrom?.pdf?.includes(ext as AllowedExtension) ?? false) ||
        (TARGETS[targetId].engineFrom?.pandoc?.includes(ext as AllowedExtension) ?? false) ||
        (TARGETS[targetId].engineFrom?.data?.includes(ext as AllowedExtension) ?? false) ||
        (TARGETS[targetId].engineFrom?.ebook?.includes(ext as AllowedExtension) ?? false) ||
        (TARGETS[targetId].engineFrom?.email?.includes(ext as AllowedExtension) ?? false);
      const isArchiveTarget = TARGETS[targetId].mode === 'archive';
      const isTranscodeTarget = TARGETS[targetId].mode === 'transcode';
      const isDataTarget = TARGETS[targetId].mode === 'data';
      const isHeifTarget = TARGETS[targetId].mode === 'heif';
      const isAssimpTarget = TARGETS[targetId].mode === '3d';
      const isEbookTarget = TARGETS[targetId].mode === 'ebook';
      const isFontTarget = TARGETS[targetId].mode === 'font';
      if (
        TARGETS[targetId].mode !== 'extract' &&
        !isArchiveTarget &&
        !isTranscodeTarget &&
        !isDataTarget &&
        !isHeifTarget &&
        !isAssimpTarget &&
        !isEbookTarget &&
        !isFontTarget &&
        !reachesViaEngine &&
        !source.family
      ) {
        problems.push(
          `source "${ext}" has no family but advertises "${targetId}", which LibreOffice must produce`,
        );
      }
      // The other half of the extract check above: a source that offers an
      // extract target must be one the target named, or the extractor would
      // be handed a document it cannot open.
      if (
        TARGETS[targetId].mode === 'extract' &&
        !(TARGETS[targetId].extractFrom as readonly string[]).includes(ext)
      ) {
        problems.push(
          `source "${ext}" advertises the extract target "${targetId}", which does not name it`,
        );
      }
    }
    // A source that can become itself is a no-op conversion that still burns a
    // soffice process and, worse, reads as a supported request.
    if ((source.targets as readonly string[]).includes(ext.slice(1))) {
      problems.push(`source "${ext}" lists its own format as a target`);
    }
    // `family` is a claim that LibreOffice opens this file, so a source that
    // makes the claim and then offers nothing but extracts is either missing a
    // target or has a family it does not use. Both halves matter: without this,
    // a `.docx` could lose its family and every soffice target would silently
    // become a 415 while the matrix still advertised them.
    if (source.family && !source.targets.some((id) => TARGETS[id]?.mode !== 'extract')) {
      problems.push(
        `source "${ext}" declares family "${source.family}" but offers only extract targets`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Conversion matrix is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

validateMatrix();

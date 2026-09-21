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
  | 'markdown';

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
  | '.ipynb';

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
  mode: 'direct' | 'raster' | 'extract';
  /**
   * Does this target answer with a ZIP of several files rather than one file?
   *
   * Declared rather than derived, because it is not derivable: a raster target
   * is always `true` (one image per page, and it archives even for a
   * single-page source so that the response type does not depend on how many
   * slides the upload happened to have), a direct target is always `false`, and
   * the two extract targets differ from each other in exactly this respect.
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
   * `pdf-engine.service.ts`) reaching `docx`/`pptx`/`xlsx`/`markdown`, and
   * the pandoc-readable markup formats (via `pandoc.service.ts`) reaching
   * `docx`/`html`/`odt`/`rtf`/`txt`/`markdown`.
   *
   * Keyed by engine rather than a flat list, because there are now two
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
    engineFrom: { pandoc: MARKUP_EXTENSIONS },
  },
  html: {
    id: 'html',
    extension: '.html',
    mediaType: 'text/html; charset=utf-8',
    label: 'HTML',
    mode: 'direct',
    multiple: false,
    filters: { writer: 'HTML (StarWriter)', calc: 'HTML (StarCalc)' },
    engineFrom: { pandoc: MARKUP_EXTENSIONS },
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
    targets: ['pdf', 'odt', 'txt', 'html', 'rtf', 'epub', 'tables'],
  },
  '.doc': {
    extension: '.doc',
    family: 'writer',
    mediaType: 'application/msword',
    importFilter: 'MS Word 97',
    targets: ['pdf', 'odt', 'txt', 'html', 'rtf', 'epub'],
  },
  '.dot': {
    extension: '.dot',
    family: 'writer',
    mediaType: 'application/msword',
    importFilter: 'MS Word 97 Vorlage',
    // A Word template: the same binary container as `.doc`, so it gets the
    // same target list - no `tables`, for the same reason `.doc` has none.
    targets: ['pdf', 'odt', 'txt', 'html', 'rtf', 'epub'],
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
    targets: ['pdf', 'odt', 'txt', 'html', 'rtf', 'epub'],
  },
  '.odt': {
    extension: '.odt',
    family: 'writer',
    mediaType: 'application/vnd.oasis.opendocument.text',
    importFilter: 'writer8',
    // The reverse direction from the matrix: a LibreOffice-native document back
    // into the Microsoft formats. Deliberately just these two - the table does
    // not promise ODT -> TXT/HTML/RTF, and a target we advertise is a target we
    // have to keep working.
    targets: ['pdf', 'docx'],
  },
  '.ods': {
    extension: '.ods',
    family: 'calc',
    mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
    importFilter: 'calc8',
    targets: ['pdf', 'xlsx'],
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
    targets: ['pdf', 'ods', 'csv', 'html'],
  },
  '.xlsm': {
    extension: '.xlsm',
    family: 'calc',
    mediaType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    importFilter: 'Calc MS Excel 2007 XML',
    targets: ['pdf', 'ods', 'csv', 'html'],
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
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.pptm': {
    extension: '.pptm',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    importFilter: 'Impress MS PowerPoint 2007 XML',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.pps': {
    extension: '.pps',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint',
    importFilter: 'MS PowerPoint 97 AutoPlay',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.ppsx': {
    extension: '.ppsx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    importFilter: 'Impress Office Open XML AutoPlay',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.pot': {
    extension: '.pot',
    family: 'impress',
    mediaType: 'application/vnd.ms-powerpoint',
    importFilter: 'MS PowerPoint 97 Vorlage',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.potx': {
    extension: '.potx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    importFilter: 'Impress MS PowerPoint 2007 XML Template',
    targets: ['pdf', 'odp', 'png', 'jpg'],
  },
  '.csv': {
    extension: '.csv',
    family: 'calc',
    mediaType: 'text/csv',
    importFilter: 'Text - txt - csv (StarCalc)',
    targets: ['xlsx', 'ods', 'pdf'],
  },
  '.txt': {
    extension: '.txt',
    family: 'writer',
    mediaType: 'text/plain',
    importFilter: 'Text',
    targets: ['pdf', 'docx', 'odt'],
  },
  '.html': {
    extension: '.html',
    family: 'writer',
    mediaType: 'text/html',
    importFilter: 'HTML (StarWriter)',
    targets: ['pdf', 'docx', 'odt'],
  },
  '.htm': {
    extension: '.htm',
    family: 'writer',
    mediaType: 'text/html',
    importFilter: 'HTML (StarWriter)',
    targets: ['pdf', 'docx', 'odt'],
  },
  '.rtf': {
    extension: '.rtf',
    family: 'writer',
    mediaType: 'application/rtf',
    importFilter: 'Rich Text Format',
    targets: ['docx', 'pdf', 'odt'],
  },
  '.png': {
    extension: '.png',
    family: 'draw',
    mediaType: 'image/png',
    importFilter: 'draw_png_Import',
    targets: ['pdf'],
  },
  '.jpg': {
    extension: '.jpg',
    family: 'draw',
    mediaType: 'image/jpeg',
    importFilter: 'draw_jpg_Import',
    targets: ['pdf'],
  },
  '.jpeg': {
    extension: '.jpeg',
    family: 'draw',
    mediaType: 'image/jpeg',
    importFilter: 'draw_jpg_Import',
    targets: ['pdf'],
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
    targets: ['pdfa', 'png', 'jpg', 'docx', 'pptx', 'xlsx', 'markdown'],
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
  engine: 'soffice' | 'extract' | 'pdf-engine' | 'pandoc';
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

  if (target.mode === 'extract') {
    // Nothing to look up: there is no LibreOffice filter for an engine that
    // does not call LibreOffice. Whether this pair is legal has already been
    // decided by the `targets` check above, and `validateMatrix` guarantees
    // the two lists agree - so reaching here means the extractor can read this
    // source, or the matrix is broken and would have thrown at import.
    return { source, target, convertTo: '', engine: 'extract' };
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
    const engines = ['pdf', 'pandoc'] as const;
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
        (TARGETS[targetId].engineFrom?.pandoc?.includes(ext as AllowedExtension) ?? false);
      if (TARGETS[targetId].mode !== 'extract' && !reachesViaEngine && !source.family) {
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

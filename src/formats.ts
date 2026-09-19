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
  | 'tables';

/** Every extension we accept as an upload. */
export type AllowedExtension =
  | '.docx'
  | '.docm'
  | '.doc'
  | '.odt'
  | '.ods'
  | '.odp'
  | '.xlsx'
  | '.pptx'
  | '.csv'
  | '.txt'
  | '.html'
  | '.htm'
  | '.rtf'
  | '.png'
  | '.jpg'
  | '.jpeg';

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
   *   - `extract` - LibreOffice is not involved at all. A part is read out of
   *     the upload's own package and turned into the target directly, which is
   *     what makes a Word document's tables available as a workbook. The
   *     engine is named by `extractFrom` rather than by a filter, and it is
   *     this mode that makes the service more than a LibreOffice front end.
   *
   * A raster target always answers with a ZIP, even for a single-page source,
   * so that the response type does not depend on how many slides the upload
   * happened to have. An `extract` target answers with ONE file - a workbook -
   * so it does not.
   */
  mode: 'direct' | 'raster' | 'extract';
  /** `direct`: the `--convert-to` argument, for each family that can produce it. */
  filters: Partial<Record<DocumentFamily, string>>;
  /**
   * For `extract`: the sources the engine can read, named explicitly.
   *
   * Keyed by EXTENSION and not by family, because the property an extract
   * depends on is not the document family - it is that the upload is a ZIP of
   * XML parts. `.docx` and `.docm` are both `writer`, and so is `.doc`, which
   * is a binary container no ZIP reader can open. The family cannot express
   * that distinction and the extension can, which is also why this is a second
   * list rather than a reuse of `filters`: the two are keyed on different
   * things because they mean different things.
   *
   * `validateMatrix` checks it in both directions, so this cannot drift out of
   * agreement with the sources that advertise the target.
   */
  extractFrom?: readonly AllowedExtension[];
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
    filters: { writer: 'writer8' },
  },
  docx: {
    id: 'docx',
    extension: '.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    mode: 'direct',
    filters: { writer: 'MS Word 2007 XML' },
  },
  txt: {
    id: 'txt',
    extension: '.txt',
    mediaType: 'text/plain; charset=utf-8',
    label: 'TXT',
    mode: 'direct',
    // `Text (encoded)` with an explicit UTF8 option: the bare `Text` filter
    // writes in the process locale, which would mangle anything non-ASCII into
    // question marks while still reporting success.
    filters: { writer: 'Text (encoded):UTF8' },
  },
  html: {
    id: 'html',
    extension: '.html',
    mediaType: 'text/html; charset=utf-8',
    label: 'HTML',
    mode: 'direct',
    filters: { writer: 'HTML (StarWriter)', calc: 'HTML (StarCalc)' },
  },
  rtf: {
    id: 'rtf',
    extension: '.rtf',
    mediaType: 'application/rtf',
    label: 'RTF',
    mode: 'direct',
    filters: { writer: 'Rich Text Format' },
  },
  epub: {
    id: 'epub',
    extension: '.epub',
    mediaType: 'application/epub+zip',
    label: 'EPUB',
    mode: 'direct',
    filters: { writer: 'EPUB' },
  },
  ods: {
    id: 'ods',
    extension: '.ods',
    mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
    label: 'ODS',
    mode: 'direct',
    filters: { calc: 'calc8' },
  },
  xlsx: {
    id: 'xlsx',
    extension: '.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    mode: 'direct',
    filters: { calc: 'Calc MS Excel 2007 XML' },
  },
  csv: {
    id: 'csv',
    extension: '.csv',
    mediaType: 'text/csv; charset=utf-8',
    label: 'CSV',
    mode: 'direct',
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
    filters: { impress: 'impress8' },
  },
  pptx: {
    id: 'pptx',
    extension: '.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    mode: 'direct',
    filters: { impress: 'Impress MS PowerPoint 2007 XML' },
  },
  png: {
    id: 'png',
    extension: '.png',
    mediaType: 'image/png',
    label: 'PNG',
    mode: 'raster',
    filters: {},
  },
  jpg: {
    id: 'jpg',
    extension: '.jpg',
    mediaType: 'image/jpeg',
    label: 'JPG',
    mode: 'raster',
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
    filters: {},
    extractFrom: ['.docx', '.docm'],
  },
};

export interface SourceFormat {
  extension: AllowedExtension;
  family: DocumentFamily;
  /** Media type soffice would call it, for `GET /formats`. */
  mediaType: string;
  /**
   * The LibreOffice import filter this extension implies.
   *
   * Informational only - soffice infers the filter from the extension of the
   * file it is handed, and we never pass an import filter on the command line.
   * It is recorded so the whole mapping stays auditable in one place.
   */
  importFilter: string;
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
  '.pptx': {
    extension: '.pptx',
    family: 'impress',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    importFilter: 'Impress MS PowerPoint 2007 XML',
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
   * The `--convert-to` argument for a `direct` target.
   *
   * Empty for a `raster` target, which is rendered to PDF first and then
   * rasterised - the caller uses `pdfFilterFor()` for that first step.
   */
  convertTo: string;
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

  if (target.mode === 'extract') {
    // Nothing to look up: there is no LibreOffice filter for an engine that
    // does not call LibreOffice. Whether this pair is legal has already been
    // decided by the `targets` check above, and `validateMatrix` guarantees
    // the two lists agree - so reaching here means the extractor can read this
    // source, or the matrix is broken and would have thrown at import.
    return { source, target, convertTo: '' };
  }

  if (target.mode === 'raster') {
    // A raster target is built from the family's PDF export, so a family that
    // cannot write a PDF cannot write an image either.
    if (!pdfFilterFor(source.family)) return null;
    return { source, target, convertTo: '' };
  }

  const filter = target.filters[source.family];
  if (!filter) return null;
  return { source, target, convertTo: `${target.extension.slice(1)}:${filter}` };
}

/** The PDF export filter for a family, if it has one. */
export function pdfFilterFor(family: DocumentFamily): string | undefined {
  return TARGETS.pdf.filters[family];
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
 * Only a raster target archives: it is one image per page and a ZIP is the
 * only way to put several files in one response. An extract target answers
 * with a single workbook however many tables the document held, and a direct
 * target always writes one file.
 */
export function archivesFiles(target: TargetFormat): boolean {
  return target.mode === 'raster';
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
    if (target.mode === 'direct' && filterCount === 0) {
      problems.push(`direct target "${id}" declares no filters`);
    }
    if (target.mode !== 'direct' && filterCount > 0) {
      problems.push(`${target.mode} target "${id}" should not declare filters`);
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
          `source "${ext}" (${source.family}) advertises "${targetId}" but has no filter for it`,
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
  }

  if (problems.length > 0) {
    throw new Error(`Conversion matrix is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

validateMatrix();

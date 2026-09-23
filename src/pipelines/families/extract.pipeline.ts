/**
 * extract: read the upload's own package, with no LibreOffice involved.
 */
import fsp from 'node:fs/promises';

import {
  MAX_DOCUMENT_XML_BYTES,
  MAX_LAYER_OUTPUT_BYTES,
  MAX_PSD_DECODE_BYTES,
  MAX_PSD_LAYERS,
  MAX_TABLES,
  MAX_TABLE_CELLS,
} from '../../config.ts';
import { ClientGoneError, Errors } from '../../errors.ts';
import type { TargetFormat, TargetId } from '../../formats.ts';
import { extractTables } from '../../lib/docx-tables.ts';
import { extractLayers, MANIFEST_FILENAME, manifestJson } from '../../lib/psd-layers.ts';
import { readZipEntry } from '../../lib/unzip.ts';
import { buildXlsx, sheetNameFor, WorkbookLimitError, type XlsxSheet } from '../../lib/xlsx.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * What the layer extractor is allowed to spend, gathered in one place.
 *
 * The defaults live in `config.ts` with the reasoning for each figure; this is
 * only the wiring, so that the three bounds that have to agree about one
 * request are read together rather than scattered through the pipeline.
 */
const LAYER_LIMITS = {
  maxDecodeBytes: MAX_PSD_DECODE_BYTES,
  maxOutputBytes: MAX_LAYER_OUTPUT_BYTES,
  maxLayers: MAX_PSD_LAYERS,
};

/**
 * The one part of a Word package the table extractor reads.
 *
 * Not `document.xml.rels`, not the styles, not the headers: tables live in the
 * body, and reading one named part is what keeps this from being a document
 * model. The cost is that a table in a header, a footer or a footnote is not
 * found - which is a real limitation, and the reason it is stated here rather
 * than left to be discovered.
 */
const DOCUMENT_PART = 'word/document.xml';

/**
 * Build the answer out of the document's contents rather than converting it.
 *
 * There is no child process here and no deadline that could be enforced, and
 * that is a deliberate trade rather than an oversight. Everything below runs
 * in-process and, once the bytes are in hand, synchronously: a scan of a
 * bounded document cannot be interrupted halfway through, so a deadline would
 * only ever be consulted after the work it was meant to bound. What bounds it
 * instead is the input - MAX_DOCUMENT_XML_BYTES before the inflate, and
 * MAX_TABLE_CELLS during the scan - and the abort signal, which is honoured at
 * the two points where honouring it is possible.
 *
 * The cost of doing this in-process rather than in a child is that the scan
 * occupies the event loop, where soffice does not. That is why the caps are
 * where they are: a document at the limit is a fraction of a second, and a
 * document past it is refused rather than merely slow.
 */
export async function runExtractPipeline(run: {
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
  /** Not enforced by the extractors; see above for why it is passed anyway. */
  deadline: number;
}): Promise<ProducedFile[]> {
  const { inputPath, target, signal } = run;

  // One entry per extract target, and the guard is the point of the table: a
  // target whose engine nobody wired up has to be a loud failure rather than a
  // silent run of some other extractor on a document it was never meant to see.
  // `test/unit.test.ts` checks the table covers every extract target the matrix
  // declares, so the failure lands at build time rather than on a request.
  const extractor = EXTRACTORS[target.id];
  if (!extractor) {
    throw Errors.internal(`no extractor for the ${target.id} target`);
  }
  if (signal?.aborted) throw new ClientGoneError();

  const archive = await fsp.readFile(inputPath);
  return extractor({ archive, inputPath, target, signal });
}

type Extractor = (run: {
  /** The whole upload, in memory. */
  archive: Buffer;
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
}) => Promise<ProducedFile[]>;

/**
 * The extract targets, and the code that answers each of them.
 *
 * `Partial` and not `Record`, deliberately: the compiler cannot then be fooled
 * into thinking the table is complete, the lookup above keeps its runtime
 * guard, and the completeness is asserted by a test instead - where a missing
 * entry is a failed build rather than a 500 in production.
 */
const EXTRACTORS: Partial<Record<TargetId, Extractor>> = {
  tables: extractTablesToWorkbook,
  layers: extractLayersToArchive,
};

/**
 * Test seam: the extract targets that have an engine.
 *
 * Exported so `test/unit.test.ts` can hold the table above to the matrix. The
 * type is `Partial` precisely so the compiler does not demand completeness, so
 * something else has to - and a test is the right place for it, because the
 * alternative is finding out on the first request that asks.
 */
export const EXTRACT_TARGET_IDS = Object.keys(EXTRACTORS) as TargetId[];

/**
 * Every table in a Word document, as one worksheet each.
 *
 * The original extract pipeline, unchanged: read `word/document.xml` out of the
 * upload's own package, scan it for tables, and write a workbook. Nothing here
 * reaches LibreOffice, which is what makes a `.docx` reach a target the
 * conversion matrix could not otherwise offer it.
 */
async function extractTablesToWorkbook(run: {
  archive: Buffer;
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { archive, inputPath, target, signal } = run;
  const part = readZipEntry(archive, DOCUMENT_PART, MAX_DOCUMENT_XML_BYTES);

  if (part.kind === 'too-large') {
    throw Errors.tooLarge(
      `${DOCUMENT_PART} declares ${part.declaredBytes} bytes, over the ${MAX_DOCUMENT_XML_BYTES} byte ceiling`,
    );
  }
  if (part.kind === 'missing') {
    // Not a ZIP at all, or a ZIP without a document part. Either way the
    // upload is not the .docx its extension claims - which is E_CONVERT_FAILED
    // and deliberately not E_NO_TABLES, because there is nothing to say about
    // tables until we can read the document they would be in.
    throw Errors.convertFailed(`${inputPath} has no readable ${DOCUMENT_PART}`);
  }

  const extraction = extractTables(part.data.toString('utf8'), MAX_TABLE_CELLS, MAX_TABLES);
  if (extraction.kind === 'too-large') {
    throw Errors.tooLarge(
      extraction.reason === 'cells'
        ? `document holds more than ${MAX_TABLE_CELLS} table cells`
        : `document holds more than ${MAX_TABLES} tables`,
    );
  }
  if (extraction.tables.length === 0) {
    // Not a failure of ours and not a damaged document: it simply has no
    // tables, and saying so is the whole of the useful answer.
    throw Errors.noTables();
  }

  const takenNames = new Set<string>();
  const sheets: XlsxSheet[] = extraction.tables.map((rows, index) => ({
    name: sheetNameFor(index + 1, takenNames),
    rows,
  }));

  let workbook: Buffer;
  try {
    workbook = buildXlsx(sheets);
  } catch (error) {
    if (error instanceof WorkbookLimitError) {
      // Excel refuses the whole workbook over a limit, so an oversized cell or
      // a worksheet too tall or wide to represent would otherwise produce a
      // file the user cannot open - or, worse, one silently missing the end of
      // a table. Refusing says so instead.
      throw Errors.tooLarge(error.message);
    }
    throw error;
  }

  // The last point at which an abort can still change the outcome. Everything
  // between the read and here was synchronous, so a client that left during it
  // could not be noticed until now - and if it did leave, the workbook is
  // still worth having built: it costs nothing to discard, and the alternative
  // is a check that cannot be placed anywhere more useful.
  if (signal?.aborted) throw new ClientGoneError();

  return [{ name: `converted${target.extension}`, data: workbook }];
}

/**
 * Every layer of a Photoshop document, as its own PNG, in one archive.
 *
 * The second engine that reaches no LibreOffice, and a different shape of
 * answer from the first: `tables` puts however many tables a document holds
 * into one workbook, while this returns one file per layer plus a manifest -
 * which is why its target declares `multiple` and `tables` does not.
 *
 * The `name` on each produced file is the archive entry name rather than a
 * download filename: `Buttons/Hover.png` is where the layers panel put it, and
 * nesting is how the document's own grouping survives the trip. `manifest.json`
 * sits alongside them and describes every layer, including the ones that
 * produced no file and why.
 *
 * Everything expensive here already happened in `extractLayers`, which is
 * synchronous and cannot be interrupted part-way. The abort checks below are
 * therefore only about the work still to come, and there is exactly one piece
 * of it - assembling the manifest - so this is the honest place for the last
 * one, not a deadline that would be consulted after the fact.
 */
async function extractLayersToArchive(run: {
  archive: Buffer;
  target: TargetFormat;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { archive, target, signal } = run;

  const extraction = extractLayers(archive, LAYER_LIMITS, signal);

  switch (extraction.kind) {
    case 'too-large':
      throw Errors.tooLarge(extraction.reason);
    case 'no-layers':
      // The layer-shaped twin of E_NO_TABLES: the document opened and was read,
      // and simply holds nothing this service can draw.
      throw Errors.noLayers();
    case 'unreadable':
      // Not a PSD, or not one we can read. E_CONVERT_FAILED for the same reason
      // the tables path uses it for a .docx that is not a ZIP: there is nothing
      // to say about a document's layers until the document can be read.
      throw Errors.convertFailed(`could not read ${target.id} from the upload: ${extraction.reason}`);
    case 'cancelled':
      throw new ClientGoneError();
    case 'ok':
      break;
  }

  if (signal?.aborted) throw new ClientGoneError();

  return [
    ...extraction.layers.map((layer) => ({ name: layer.file, data: layer.data })),
    { name: MANIFEST_FILENAME, data: manifestJson(extraction.manifest) },
  ];
}

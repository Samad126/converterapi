/**
 * The data-interchange engine: CSV/TSV/JSON/JSONL/YAML in, any of the same
 * five out. Pure JS, no subprocess - unlike every other engine in this
 * service, there is no external binary to run, because Node's own `JSON`
 * and the `yaml` package (already a real dependency - see `openapi.ts`,
 * which uses it to read this service's own spec) already are trusted,
 * correct parsers/serializers for three of the five formats, and
 * `../lib/csv.ts` is a fourth this file writes itself for the same reason
 * that file's own header comment gives.
 *
 * ONE COMMON MODEL. Every source is read into a plain JS value - `unknown`,
 * not a format-specific shape - and every target is written from one. JSON,
 * JSONL and YAML can hold that value AS IS: JSONL is simply "one JSON value
 * per line", so its whole value is an array. CSV and TSV cannot: a
 * delimited file has no way to represent nesting, so writing one requires
 * the value to already be a TABLE - a top-level array of FLAT objects (no
 * value inside them is itself an object or array). This is not a limitation
 * this engine invented; it is the same convention every CSV<->JSON tool
 * uses, because there is no other honest way to do it. A value that is not
 * shaped like a table fails with a message that says so, exactly as
 * `tables` fails honestly on a PDF with no ruled table rather than
 * inventing one - see `conversion.service.ts`'s `extractTablesToWorkbook`.
 *
 * READING a CSV/TSV never produces anything but strings - every cell is
 * text on disk, and this engine does not guess whether "007" was meant to
 * stay a string or become the number 7. A round trip through JSON keeps
 * every value exactly as delimited text spelled it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { Errors } from '../errors.ts';
import type { AllowedExtension, TargetId } from '../formats.ts';
import { parseDelimited, stringifyDelimited } from '../lib/csv.ts';

/** A row's worth of data, once read out of CSV/TSV - every value is a string. */
type TableRecord = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row this engine can write to CSV/TSV: no value is itself an object or array. */
function isFlatRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => !isPlainObject(v) && !Array.isArray(v));
}

function isTabularArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isFlatRecord);
}

function tableToRecords(rows: string[][]): TableRecord[] {
  if (rows.length === 0) return [];
  const [header, ...body] = rows as [string[], ...string[][]];
  return body.map((row) => {
    const record: TableRecord = {};
    header.forEach((key, i) => {
      record[key] = row[i] ?? '';
    });
    return record;
  });
}

/** The reverse of `tableToRecords`: a header row (every key any record used, in first-seen order) plus one row per record. */
function recordsToTable(records: readonly Record<string, unknown>[]): string[][] {
  const keys: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const rows: string[][] = [keys];
  for (const record of records) {
    rows.push(
      keys.map((key) => {
        const value = record[key];
        return value === undefined || value === null ? '' : String(value);
      }),
    );
  }
  return rows;
}

/** Read a data source's bytes into the common JS value every target serialises from. */
export function parseDataSource(extension: AllowedExtension, text: string): unknown {
  switch (extension) {
    case '.csv':
      return tableToRecords(parseDelimited(text, ','));
    case '.tsv':
      return tableToRecords(parseDelimited(text, '\t'));
    case '.json':
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw Errors.convertFailed(`not valid JSON: ${(err as Error).message}`);
      }
    case '.jsonl': {
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
      try {
        return lines.map((line) => JSON.parse(line) as unknown);
      } catch (err) {
        throw Errors.convertFailed(`not valid JSON Lines: ${(err as Error).message}`);
      }
    }
    case '.yaml':
    case '.yml':
      try {
        return parseYaml(text) as unknown;
      } catch (err) {
        throw Errors.convertFailed(`not valid YAML: ${(err as Error).message}`);
      }
    default:
      // Unreachable as the matrix stands - `validateMatrix` ties every
      // `data`-mode/`engineFrom.data` source to one of the cases above -
      // but a target added to one without the other fails loudly here
      // rather than silently producing nothing.
      throw Errors.internal(`"${extension}" has no data-engine reader`);
  }
}

/** Write the common JS value out as one target format's bytes. */
export function serializeDataTarget(targetId: TargetId, value: unknown): string {
  switch (targetId) {
    case 'csv':
    case 'tsv': {
      if (!isTabularArray(value)) {
        throw Errors.notTabular(
          targetId.toUpperCase(),
          'a flat table of records (a top-level list of flat objects)',
        );
      }
      return stringifyDelimited(recordsToTable(value), targetId === 'csv' ? ',' : '\t');
    }
    case 'json':
      return JSON.stringify(value, null, 2) + '\n';
    case 'jsonl': {
      // JSON Lines has the same shape requirement as CSV/TSV in one
      // respect - the value must be a top-level array, one element per
      // line - but not the "flat objects only" half: an element can be
      // any JSON value, nested or not, since each line is independently
      // valid JSON with no delimited-text column structure to preserve.
      if (!Array.isArray(value)) throw Errors.notTabular('JSONL', 'a top-level array, one element per line');
      return value.length === 0 ? '' : value.map((item) => JSON.stringify(item)).join('\n') + '\n';
    }
    case 'yaml':
      return stringifyYaml(value);
    default:
      throw Errors.internal(`"${targetId}" has no data-engine writer`);
  }
}

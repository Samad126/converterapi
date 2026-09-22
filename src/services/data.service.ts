/**
 * The data-interchange engine: CSV/TSV/JSON/JSONL/YAML/XML/TOML/INI/SQLite
 * in, any of the same nine out. Pure JS (well, mostly - see the SQLite note
 * below), no subprocess - unlike every other engine in this service, there
 * is no external binary to run, because Node's own `JSON` and the `yaml`
 * package (already a real dependency - see `openapi.ts`, which uses it to
 * read this service's own spec) already are trusted, correct
 * parsers/serializers for three of the formats, `xml-js`/`smol-toml`/`ini`
 * are the same for XML/TOML/INI (added for this feature - each is small,
 * has at most one dependency of its own, and is the standard tool for its
 * format, the same bar `yaml` was already held to), and `../lib/csv.ts` is
 * a hand-written one for the reason that file's own header comment gives.
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
 * TOML and a `.sqlite` table need "the value is an OBJECT" (TOML has no
 * concept of a bare top-level array or scalar - verified by hand: `smol-toml`
 * throws "stringify can only be called with an object" for either) or "the
 * value is a TABLE" (SQLite, same shape CSV/TSV need) respectively - each
 * checked the same explicit way, before the library gets a chance to either
 * throw an unhelpful error or (for XML/INI, verified by hand: neither
 * `xml-js` nor `ini` throws on a bad top-level shape - both silently treat a
 * string's characters or an array's indices as object keys) produce
 * something that is not an honest rendering of the source at all.
 *
 * READING a CSV/TSV never produces anything but strings - every cell is
 * text on disk, and this engine does not guess whether "007" was meant to
 * stay a string or become the number 7. A round trip through JSON keeps
 * every value exactly as delimited text spelled it. INI is the same, for
 * the same reason - every value in a `.ini` file is text on disk too.
 *
 * `.sqlite` IS NOT TEXT, unlike every other member of this group - it is the
 * one format this "pure JS" engine reads/writes through a real embedded
 * database (`node:sqlite`'s `DatabaseSync`, a Node BUILT-IN since Node 22.5,
 * not a dependency - verified by hand against the exact `node:22-bookworm-slim`
 * image this service's own Dockerfile builds from) rather than a text
 * parser/serializer, and its own functions below take/return a `Buffer`
 * instead of a `string` - see `runDataPipeline` in `conversion.service.ts`
 * for the one branch that reads/writes bytes instead of UTF-8 text because
 * of it. Reading takes the FIRST user table in the file (`sqlite_master`
 * minus SQLite's own internal `sqlite_%` tables) and every one of its rows,
 * as a flat record each - the exact same "top-level array of flat objects"
 * shape CSV/TSV already produce, so every other target already knows how to
 * receive it. Writing creates ONE table, named `data`, inferring its
 * columns from every key any record used (same "first-seen order" `xlsx`'s
 * own `sheetNameFor`-adjacent table writers use elsewhere in this service) -
 * a `.sqlite` file with several tables is a real shape this direction
 * cannot produce, the same honest limitation the raster/layers targets have
 * for a source shape they were never meant to reconstruct.
 */
import { parse as parseIni, stringify as stringifyIni } from 'ini';
import { DatabaseSync } from 'node:sqlite';
import { js2xml, xml2js } from 'xml-js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
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
    case '.xml':
      try {
        // `compact: true` is what makes `xml-js`'s output a plain JS value
        // this engine's other targets already know how to write - an
        // element becomes an object keyed by its own tag name, an attribute
        // becomes a `_attributes` object, and text content becomes `_text` -
        // rather than the library's default DOM-shaped node-list tree,
        // which none of CSV/JSON/YAML/TOML could represent at all.
        return xml2js(text, { compact: true }) as unknown;
      } catch (err) {
        throw Errors.convertFailed(`not valid XML: ${(err as Error).message}`);
      }
    case '.toml':
      try {
        return parseToml(text) as unknown;
      } catch (err) {
        throw Errors.convertFailed(`not valid TOML: ${(err as Error).message}`);
      }
    case '.ini':
      // `ini.parse` never throws - malformed input becomes an object minus
      // whatever line it could not make sense of, the same "permissive
      // reader" behaviour the format's own lack of a real spec makes
      // unavoidable. There is nothing to catch here.
      return parseIni(text) as unknown;
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
    case 'xml': {
      // The reverse of `.xml`'s own reader: a plain object keyed by tag
      // name, `_attributes`/`_text` understood specially - and, unlike
      // every other writer here, a real shape requirement `xml-js` itself
      // does NOT enforce (verified by hand: it silently turns a scalar's or
      // an array's own indices into garbage tag names like `<0>`/`<1>`
      // instead of refusing). XML has no way to represent more than one
      // root element, so the value must be a plain object with exactly one
      // top-level key - the root tag's own name.
      if (!isPlainObject(value) || Object.keys(value).length !== 1) {
        throw Errors.notTabular(
          'XML',
          'a plain object with exactly one top-level key (the root element\'s tag name)',
        );
      }
      return js2xml(value, { compact: true, spaces: 2 }) + '\n';
    }
    case 'toml':
      // `smol-toml` already throws its own clear error for a non-object
      // value ("stringify can only be called with an object") - TOML has no
      // concept of a bare top-level array or scalar at all, so there is
      // nothing more specific this engine could say instead.
      try {
        return stringifyToml(value as object) + '\n';
      } catch (err) {
        throw Errors.convertFailed(`cannot write TOML: ${(err as Error).message}`);
      }
    case 'ini':
      // Same shape requirement as TOML, checked ourselves rather than left
      // to the library: unlike `smol-toml`, `ini.stringify` does NOT throw
      // on a bad top-level shape (verified by hand - a scalar's characters
      // or an array's indices silently become section/key names instead).
      if (!isPlainObject(value)) {
        throw Errors.notTabular('INI', 'a plain object (its keys become sections and settings)');
      }
      return stringifyIni(value);
    default:
      throw Errors.internal(`"${targetId}" has no data-engine writer`);
  }
}

/**
 * Read the FIRST user table (`sqlite_master` minus SQLite's own internal
 * `sqlite_%` entries) out of a `.sqlite` file's bytes, as the same
 * "top-level array of flat records" shape `parseDataSource`'s CSV/TSV cases
 * already produce - see this file's own header comment for why `.sqlite` is
 * a `Buffer`, not a `string`, and the one member of this group that is.
 */
export function parseSqliteSource(bytes: Buffer): unknown {
  const db = new DatabaseSync(':memory:');
  try {
    // `@types/node@22.x` has no `serialize`/`deserialize` typings for
    // `DatabaseSync` (added upstream only in `@types/node@26`) even though
    // the METHODS themselves are real on Node 22 - verified by hand against
    // `node:22-bookworm-slim`, the exact image this service's own Dockerfile
    // builds from. A narrow cast here, rather than a major `@types/node`
    // bump across the whole codebase for one lagging `.d.ts`.
    (db as unknown as { deserialize(data: Buffer): void }).deserialize(bytes);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .all() as Array<{ name: string }>;
    const first = tables[0];
    if (!first) throw Errors.convertFailed('the SQLite file has no tables to read');
    // `name` came from `sqlite_master` itself, not from the request, so
    // quoting it into the query text here is safe the same way every other
    // engine trusts a value it read out of the document rather than one a
    // client supplied.
    return db.prepare(`SELECT * FROM "${first.name}"`).all();
  } finally {
    db.close();
  }
}

/**
 * Write the common JS value out as a `.sqlite` file's bytes - one table,
 * named `data`, same shape requirement as `csv`/`tsv` (a top-level array of
 * flat records), for the same reason: there is no other honest way to turn
 * an arbitrary JS value into a relational table.
 */
export function serializeSqliteTarget(value: unknown): Buffer {
  if (!isTabularArray(value)) {
    throw Errors.notTabular('SQLite', 'a flat table of records (a top-level list of flat objects)');
  }

  const keys: string[] = [];
  for (const record of value) {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  const db = new DatabaseSync(':memory:');
  try {
    // Every column is untyped `TEXT` storage-class-wise - SQLite's own
    // "type affinity" system stores whatever a bound value's real JS type
    // is regardless of the declared column type, so this is not a
    // stringify-every-value step the way CSV/TSV's own writer needs; it is
    // just a column list, quoted the same way `first.name` is trusted above
    // (these are keys this function itself collected, not client input).
    const columns = keys.map((key) => `"${key}"`).join(', ');
    db.exec(`CREATE TABLE "data" (${columns})`);
    const placeholders = keys.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO "data" (${columns}) VALUES (${placeholders})`);
    for (const record of value) {
      insert.run(...keys.map((key) => (record[key] ?? null) as never));
    }
    // Same lagging-typings cast as `deserialize` above.
    return Buffer.from((db as unknown as { serialize(): Uint8Array }).serialize());
  } finally {
    db.close();
  }
}

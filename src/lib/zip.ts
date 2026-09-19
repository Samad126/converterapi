/**
 * A minimal ZIP writer, so that a request whose answer is several files can
 * still be answered with one.
 *
 * Used for two things:
 *
 *   - the PNG/JPG targets, where "the answer" is one image per slide and there
 *     is no other honest way to put N files in one HTTP response;
 *   - the warm-up probe documents, which are real OOXML packages - a ZIP of XML
 *     parts - and therefore need this anyway.
 *
 * `zipStored` writes entries STORED, `zipDeflated` writes them DEFLATED, and the
 * choice is made by what is going inside. The raster payloads are PNG and JPEG,
 * which are already compressed, so deflating them would cost CPU on the request
 * path to make the archive very slightly larger - hence `zipStored`, which the
 * probe documents use too because they are a few hundred bytes converted once
 * at boot. A workbook is the opposite case: it is XML, which deflates by roughly
 * an order of magnitude, so an .xlsx built from a large table is worth the CPU.
 *
 * No ZIP64, so a single entry over 4GiB or more than 65535 entries would
 * produce a corrupt archive. Neither is reachable: uploads are capped at 25MB
 * (see MAX_UPLOAD_BYTES), the table extractor is capped in cells, and a
 * conversion that ran long enough to produce gigabytes would hit
 * CONVERT_TIMEOUT_MS first.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Name inside the archive. Sanitised - see `safeEntryName`. */
  name: string;
  data: Buffer;
}

/** Fixed DOS timestamp (1980-01-01 00:00:00) so the same input is byte-identical. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Strip anything that could make an entry name dangerous or ambiguous on the
 * machine that unpacks it.
 *
 * We generate every name ourselves, so this is belt and braces - but the whole
 * point of a zip-slip is that the name came from somewhere you did not control,
 * and the cost of not having to think about it again is one regexp.
 */
export function safeEntryName(name: string): string {
  const cleaned = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/')
    .replace(/^\/+/, '');
  return cleaned === '' ? 'file' : cleaned;
}

/** Method 0 of the ZIP spec: the payload is the bytes themselves. */
const METHOD_STORED = 0;
/** Method 8: the payload is a raw DEFLATE stream. */
const METHOD_DEFLATE = 8;

/** The same entry can be the same input and still not the same bytes, so a level. */
const DEFLATE_LEVEL = 6;

export function zipStored(entries: readonly ZipEntry[]): Buffer {
  return buildZip(entries, METHOD_STORED);
}

/**
 * The same archive, with the payloads DEFLATE-compressed.
 *
 * For XML, and only XML. `[Content_Types].xml` and a workbook's sheets are
 * highly repetitive text and shrink by around 10x, which is the difference
 * between a download a phone can take and one it cannot; a PNG would shrink by
 * nothing and cost CPU for it.
 */
export function zipDeflated(entries: readonly ZipEntry[]): Buffer {
  return buildZip(entries, METHOD_DEFLATE);
}

function buildZip(entries: readonly ZipEntry[], method: number): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), 'utf8');
    const crc = crc32(entry.data) >>> 0;
    // STORED means "the payload is the data", so the two sizes are the same
    // number; DEFLATE means they are not, and telling the reader the wrong
    // uncompressed size is how an archive that unpacks to nothing gets made.
    const payload =
      method === METHOD_DEFLATE ? deflateRawSync(entry.data, { level: DEFLATE_LEVEL }) : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8); // flags
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(header, name);

    offset += local.length + name.length + payload.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16); // offset of central directory
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, end]);
}

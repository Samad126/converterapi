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
 * Entries are STORED, never deflated. That is not laziness: the payloads are
 * PNG and JPEG, which are already compressed, so deflating them would cost CPU
 * on the request path to make the archive very slightly larger. The one place
 * it does cost bytes is the probe documents, which are a few hundred bytes and
 * converted once at boot.
 *
 * No ZIP64, so a single entry over 4GiB or more than 65535 entries would
 * produce a corrupt archive. Neither is reachable: uploads are capped at 25MB
 * (see MAX_UPLOAD_BYTES) and a conversion that ran long enough to produce
 * gigabytes would hit CONVERT_TIMEOUT_MS first.
 */
import { crc32 } from 'node:zlib';

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

export function zipStored(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), 'utf8');
    const crc = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, name, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8); // flags
    header.writeUInt16LE(0, 10); // method: stored
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(header, name);

    offset += local.length + name.length + entry.data.length;
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

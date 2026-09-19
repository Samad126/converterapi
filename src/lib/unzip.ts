/**
 * Reading one named file out of a ZIP container.
 *
 * The mirror of `zip.ts`, and it exists for the same reason: a .docx IS a ZIP
 * of XML parts, so extracting tables from one starts with getting
 * `word/document.xml` out of it. The house rule is that a format we can
 * describe in a few hundred lines does not justify a dependency, and this is
 * that description - the parts of the ZIP spec a reader needs, and no more.
 *
 * Scope is deliberately narrow, and the narrowness is the security property:
 * we look up ONE entry by name and return its bytes. We never list the
 * archive, never write anything to disk, and never build a path out of a name
 * that came from inside the file. Zip-slip is a hazard of unpacking, and we
 * do not unpack.
 *
 * The hazard that IS real is a decompression bomb - a small entry whose
 * declared uncompressed size is enormous. `zipStored`'s comment puts the
 * ceiling on our own archives at 4GiB; for a file a client uploaded there is
 * no ceiling at all unless we impose one. So `maxBytes` is required rather
 * than optional, and it is enforced twice: once against the size the central
 * directory declares, before any work is done, and once as the inflate's own
 * output cap, which is what catches a directory that lied.
 */
import { inflateRawSync } from 'node:zlib';

/** "PK\5\6" - the record that closes the archive and points at the directory. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** "PK\1\2" - one entry in the central directory. */
const CENTRAL_HEADER = 0x02014b50;
/** "PK\3\4" - one entry's local header. */
const LOCAL_HEADER = 0x04034b50;

/** Method 0: the bytes themselves. */
const METHOD_STORED = 0;
/** Method 8: a raw DEFLATE stream. */
const METHOD_DEFLATE = 8;

/** The end record is 22 bytes, plus up to 65535 of trailing comment. */
const END_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

export type ZipReadResult =
  | { kind: 'found'; data: Buffer }
  /** No such entry, or the bytes are not an archive we can follow. */
  | { kind: 'missing' }
  /**
   * The entry exists but decompresses past the caller's ceiling.
   *
   * Its own case rather than folded into `missing`, because the two mean
   * opposite things to the person holding the phone: "missing" is a document
   * that is not what its extension claims, "too-large" is a real document we
   * declined to expand.
   */
  | { kind: 'too-large'; declaredBytes: number };

/**
 * Pull one entry out of an archive by its exact name.
 *
 * The name is matched verbatim - ZIP directory names are case-sensitive and
 * always use forward slashes - and it comes from our own constants, never from
 * the upload, so there is nothing to sanitise on the way in.
 */
export function readZipEntry(archive: Buffer, wanted: string, maxBytes: number): ZipReadResult {
  const end = findCentralDirectory(archive);
  if (end === -1) return { kind: 'missing' };

  const entry = findEntry(archive, end, wanted);
  if (!entry) return { kind: 'missing' };

  // Refuse before inflating anything. A 25MB upload can declare a 4GiB part,
  // and the whole point of a bomb is that the work is done by the time you
  // notice - so the check has to come first, not after.
  if (entry.uncompressedSize > maxBytes) {
    return { kind: 'too-large', declaredBytes: entry.uncompressedSize };
  }

  return readEntryData(archive, entry, maxBytes);
}

interface CentralEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/**
 * Locate the end-of-central-directory record.
 *
 * Scanned backwards because the record is at the end, and backwards from the
 * earliest possible position rather than the last byte because a ZIP is
 * allowed a trailing comment - so a plain "read the last 22 bytes" is wrong on
 * any archive an archiver has annotated.
 */
function findCentralDirectory(archive: Buffer): number {
  if (archive.length < END_MIN_BYTES) return -1;

  const lowest = Math.max(0, archive.length - END_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let at = archive.length - END_MIN_BYTES; at >= lowest; at -= 1) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return -1;
}

/**
 * Walk the central directory looking for one name.
 *
 * The central directory rather than the local headers, because it is the only
 * place that states a size before the data is reached - which is exactly what
 * the bomb check needs. It is also the copy that an archiver always writes.
 */
function findEntry(archive: Buffer, end: number, wanted: string): CentralEntry | null {
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);

  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_HEADER_BYTES > archive.length) return null;
    if (archive.readUInt32LE(at) !== CENTRAL_HEADER) return null;

    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const uncompressedSize = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);

    const nameEnd = at + CENTRAL_HEADER_BYTES + nameLength;
    if (nameEnd > archive.length) return null;
    const name = archive.subarray(at + CENTRAL_HEADER_BYTES, nameEnd).toString('utf8');

    if (name === wanted) return { method, compressedSize, uncompressedSize, localOffset };

    at = nameEnd + extraLength + commentLength;
  }
  return null;
}

/**
 * Read and decompress the data the central directory pointed at.
 *
 * The name and extra lengths are re-read from the LOCAL header rather than
 * reused from the central one, because the two are allowed to differ - the
 * extra field in particular is often present in the directory and absent
 * locally - and using the wrong length silently shifts the start of the data.
 */
function readEntryData(archive: Buffer, entry: CentralEntry, maxBytes: number): ZipReadResult {
  const at = entry.localOffset;
  if (at + LOCAL_HEADER_BYTES > archive.length) return { kind: 'missing' };
  if (archive.readUInt32LE(at) !== LOCAL_HEADER) return { kind: 'missing' };

  const nameLength = archive.readUInt16LE(at + 26);
  const extraLength = archive.readUInt16LE(at + 28);
  const start = at + LOCAL_HEADER_BYTES + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) return { kind: 'missing' };

  const payload = archive.subarray(start, end);

  if (entry.method === METHOD_STORED) {
    // Copied rather than returned as a subarray: a view would keep the whole
    // upload alive for as long as the part is held, which on a 25MB upload is
    // 25MB of retention for a few kilobytes of XML.
    return { kind: 'found', data: Buffer.from(payload) };
  }
  if (entry.method !== METHOD_DEFLATE) return { kind: 'missing' };

  try {
    // `maxOutputLength` is the backstop for a central directory that declared
    // a small size and then delivered a large one. It aborts the inflate
    // rather than growing the buffer, so a lying archive costs us nothing.
    return { kind: 'found', data: inflateRawSync(payload, { maxOutputLength: maxBytes }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      return { kind: 'too-large', declaredBytes: entry.uncompressedSize };
    }
    // Any other zlib failure is a corrupt stream: the entry is not readable,
    // which is the same outcome as it not being there.
    return { kind: 'missing' };
  }
}

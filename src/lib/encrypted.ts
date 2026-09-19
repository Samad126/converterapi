/**
 * Detecting password-protected documents, before soffice gets a chance to
 * mangle the explanation.
 *
 * Worth doing ourselves because soffice has no distinct signal for it: an
 * encrypted document and a corrupt one both come back as "could not be loaded",
 * and telling a user their file is damaged when it merely needs a password is
 * both wrong and unhelpful.
 *
 * ECMA-376 encryption wraps the package in an OLE/CFB container holding an
 * `EncryptedPackage` stream, so an encrypted .docx/.docm stops being a zip.
 * Legacy .doc files stay CFB either way and set `fEncrypted` (or `fObfuscated`)
 * in the FIB.
 *
 * Best effort by design: anything we cannot parse confidently returns false and
 * the decision falls through to soffice. A false negative costs a less specific
 * error message; a false positive would reject a document we could have
 * converted, which is much worse.
 *
 * The OOXML, Word binary and PDF formats are inspected. An encrypted ODF file
 * (.odt/.ods/.odp) is left to soffice, which reports it the same way it
 * reports a damaged file - acceptable, because those are not formats this
 * service reaches through soffice for anything that would otherwise give a
 * worse error.
 */
import fsp from 'node:fs/promises';

/** Best-effort encryption sniffing gives up past this; soffice decides instead. */
const DETECTION_MAX_BYTES = 8 * 1024 * 1024;

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF_MAGIC = Buffer.from('%PDF-');

export async function isPasswordProtected(inputPath: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(inputPath, 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 5) return false;

    const stat = await handle.stat();
    if (stat.size > DETECTION_MAX_BYTES) return false;

    if (head.subarray(0, 5).equals(PDF_MAGIC)) {
      const buffer = await fsp.readFile(inputPath);
      return pdfLooksEncrypted(buffer);
    }

    if (bytesRead < 8 || !head.equals(CFB_MAGIC)) {
      // A zip-based package (.docx/.docm) is never encrypted in place, and
      // anything else is not our problem to classify.
      return false;
    }

    const buffer = await fsp.readFile(inputPath);
    return cfbLooksEncrypted(buffer);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Best-effort PDF encryption sniffing: does the CURRENT trailer name an
 * `/Encrypt` dictionary?
 *
 * Deliberately not a whole-file search for the token, which is what this used
 * to be and which has a real false-positive mode: a PDF that was ever
 * encrypted and later re-saved - a password removed, or simply saved again by
 * Acrobat - keeps its earlier revision's bytes physically in the file,
 * `/Encrypt` entry included, even though that revision no longer governs
 * anything. Per the spec (ISO 32000-1 §7.5.5), an encrypted file's `/Encrypt`
 * key must be in the trailer of the LAST update, so that is the only
 * dictionary worth reading: found by following the final `startxref` to
 * either a classic `xref`/`trailer` section or, in a PDF 1.5+ file, a
 * cross-reference stream object whose own dictionary IS the trailer.
 *
 * Still best effort, not a full parser: a file whose structure this cannot
 * follow (an unusual xref layout, truncation, a byte offset that turns out
 * not to point where `startxref` claims) answers `false` rather than guess -
 * the same trade this file makes everywhere else, and more important here
 * than most, since the whole point of this rewrite is to stop an unrelated
 * old revision from producing a false positive.
 */
function pdfLooksEncrypted(buffer: Buffer): boolean {
  const dictionary = lastTrailerDictionary(buffer);
  return dictionary !== null && dictionary.includes('/Encrypt');
}

const STARTXREF = Buffer.from('startxref');
const XREF_KEYWORD = Buffer.from('xref');
const TRAILER_KEYWORD = Buffer.from('trailer');
const OBJ_KEYWORD = Buffer.from('obj');
const DICT_OPEN = Buffer.from('<<');

/**
 * How far past a `trailer`/`obj` keyword the opening `<<` is allowed to be.
 * The grammar puts it right there - "trailer\n<<" and "12 0 obj<<" are the
 * only shapes real writers produce - so a `<<` found further away than this
 * means the keyword match was spurious (inside a string or a comment) and
 * the file should be treated as unreadable rather than searched blindly.
 */
const DICT_OPEN_PROXIMITY = 256;

/** The trailer dictionary of the file's most recent update, as raw text. */
function lastTrailerDictionary(buffer: Buffer): string | null {
  const startxrefAt = buffer.lastIndexOf(STARTXREF);
  if (startxrefAt < 0) return null;

  const offset = readUnsignedInt(buffer, startxrefAt + STARTXREF.length);
  if (offset === null || offset < 0 || offset >= buffer.length) return null;

  const at = skipPdfWhitespace(buffer, offset);

  if (matchesAt(buffer, at, XREF_KEYWORD)) {
    // Classic cross-reference table: the trailer dictionary follows the
    // "trailer" keyword that closes this section.
    const trailerAt = buffer.indexOf(TRAILER_KEYWORD, at + XREF_KEYWORD.length);
    if (trailerAt < 0) return null;
    const dictStart = buffer.indexOf(DICT_OPEN, trailerAt + TRAILER_KEYWORD.length);
    if (dictStart < 0 || dictStart - trailerAt > DICT_OPEN_PROXIMITY) return null;
    return readDictionaryText(buffer, dictStart);
  }

  // Otherwise `startxref` points straight at an indirect object, "N G obj",
  // which for a PDF 1.5+ cross-reference STREAM is the trailer itself - the
  // spec allows a file to have no "trailer" keyword at all in that case.
  const objEnd = skipIndirectObjectHeader(buffer, at);
  if (objEnd === null) return null;
  const dictStart = buffer.indexOf(DICT_OPEN, objEnd);
  if (dictStart < 0 || dictStart - objEnd > DICT_OPEN_PROXIMITY) return null;
  return readDictionaryText(buffer, dictStart);
}

/**
 * Read a `<< ... >>` dictionary's raw text, respecting nesting and the two
 * places a stray `<`/`>` legitimately appears - a literal `(string)` and a
 * hex `<string>` - so that neither is mistaken for a dictionary delimiter.
 *
 * `dictStart` must point at the first `<` of the opening `<<`. Returns `null`
 * for anything that does not close cleanly before the buffer ends, which
 * covers both a genuinely malformed file and this function's own inability
 * to make sense of one - the same "give up rather than guess" this whole
 * detector is built on.
 */
function readDictionaryText(buffer: Buffer, dictStart: number): string | null {
  if (!matchesAt(buffer, dictStart, DICT_OPEN)) return null;

  let i = dictStart + 2;
  let depth = 1;
  const end = buffer.length;

  while (i < end && depth > 0) {
    const byte = buffer[i]!;

    if (byte === 0x25) {
      // % comment: runs to end of line.
      while (i < end && buffer[i] !== 0x0a && buffer[i] !== 0x0d) i += 1;
      continue;
    }

    if (byte === 0x28) {
      // ( literal string: balanced, backslash-escaped parens included.
      i += 1;
      let stringDepth = 1;
      while (i < end && stringDepth > 0) {
        if (buffer[i] === 0x5c) {
          i += 2;
          continue;
        }
        if (buffer[i] === 0x28) stringDepth += 1;
        else if (buffer[i] === 0x29) stringDepth -= 1;
        i += 1;
      }
      continue;
    }

    if (byte === 0x3c) {
      if (buffer[i + 1] === 0x3c) {
        depth += 1;
        i += 2;
        continue;
      }
      // < hex string: runs to the closing >, which cannot itself be escaped.
      i += 1;
      while (i < end && buffer[i] !== 0x3e) i += 1;
      i += 1;
      continue;
    }

    if (byte === 0x3e) {
      if (buffer[i + 1] === 0x3e) {
        depth -= 1;
        i += 2;
        continue;
      }
      i += 1; // A lone '>' should not happen; do not get stuck on it.
      continue;
    }

    i += 1;
  }

  if (depth !== 0) return null;
  return buffer.toString('latin1', dictStart, i);
}

function skipPdfWhitespace(buffer: Buffer, at: number): number {
  let i = at;
  while (i < buffer.length && isPdfWhitespaceByte(buffer[i]!)) i += 1;
  return i;
}

/** PDF's whitespace set (ISO 32000-1 §7.2.2) - not the same as ASCII's. */
function isPdfWhitespaceByte(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function matchesAt(buffer: Buffer, at: number, token: Buffer): boolean {
  return buffer.subarray(at, at + token.length).equals(token);
}

/** The unsigned integer starting at (or after whitespace from) `at`. */
function readUnsignedInt(buffer: Buffer, at: number): number | null {
  const start = skipPdfWhitespace(buffer, at);
  let i = start;
  while (i < buffer.length && isDigitByte(buffer[i]!)) i += 1;
  if (i === start) return null;
  return Number.parseInt(buffer.toString('latin1', start, i), 10);
}

/** Past "N G obj", returning the index right after "obj", or `null`. */
function skipIndirectObjectHeader(buffer: Buffer, at: number): number | null {
  let i = skipPdfWhitespace(buffer, at);
  const numberStart = i;
  while (i < buffer.length && isDigitByte(buffer[i]!)) i += 1;
  if (i === numberStart) return null;

  i = skipPdfWhitespace(buffer, i);
  const generationStart = i;
  while (i < buffer.length && isDigitByte(buffer[i]!)) i += 1;
  if (i === generationStart) return null;

  i = skipPdfWhitespace(buffer, i);
  if (!matchesAt(buffer, i, OBJ_KEYWORD)) return null;
  return i + OBJ_KEYWORD.length;
}

interface CfbDirectory {
  streams: Map<string, { startSector: number; size: number }>;
  sectorSize: number;
  miniCutoff: number;
}

function cfbLooksEncrypted(buffer: Buffer): boolean {
  const directory = readCfbDirectory(buffer);
  if (!directory) return false;

  // Agile/Standard encryption: the package is a CFB holding EncryptedPackage.
  if (directory.streams.has('EncryptedPackage')) return true;

  const wordDocument = directory.streams.get('WordDocument');
  if (!wordDocument) return false;
  // Small streams live in the mini-FAT, which we deliberately do not follow -
  // a real WordDocument stream is never that small.
  if (wordDocument.size < directory.miniCutoff) return false;

  const offset = sectorOffset(wordDocument.startSector, directory.sectorSize);
  if (offset + 16 > buffer.length) return false;

  const wIdent = buffer.readUInt16LE(offset);
  if (wIdent !== 0xa5ec) return false; // Not a Word FIB; let soffice judge.

  const fibFlags = buffer.readUInt16LE(offset + 10);
  const fEncrypted = (fibFlags & 0x0100) !== 0;
  const fObfuscated = (fibFlags & 0x8000) !== 0;
  return fEncrypted || fObfuscated;
}

function sectorOffset(sector: number, sectorSize: number): number {
  return (sector + 1) * sectorSize;
}

/**
 * Minimal OLE/CFB directory reader: enough to list stream names and locations.
 *
 * Header field offsets (MS-CFB):
 *   0x1E sector shift (log2 of sector size)
 *   0x2C number of FAT sectors
 *   0x30 first directory sector
 *   0x38 mini stream cutoff
 *   0x4C DIFAT[0..108]
 */
function readCfbDirectory(buffer: Buffer): CfbDirectory | null {
  if (buffer.length < 512) return null;

  const sectorShift = buffer.readUInt16LE(0x1e);
  if (sectorShift < 7 || sectorShift > 20) return null;
  const sectorSize = 1 << sectorShift;
  const miniCutoff = buffer.readUInt32LE(0x38) || 4096;
  const firstDirSector = buffer.readUInt32LE(0x30);

  // Build the FAT from the header's DIFAT. The first 109 entries cover ~7MB of
  // FAT with 512-byte sectors - far more than any document we accept needs -
  // and a file that wants more simply falls through to soffice.
  const fat: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sector = buffer.readUInt32LE(0x4c + i * 4);
    if (sector === 0xffffffff) break;
    const offset = sectorOffset(sector, sectorSize);
    if (offset + sectorSize > buffer.length) break;
    for (let entry = 0; entry < sectorSize / 4; entry += 1) {
      fat.push(buffer.readUInt32LE(offset + entry * 4));
    }
  }
  if (fat.length === 0) return null;

  const streams = new Map<string, { startSector: number; size: number }>();
  const visited = new Set<number>();
  let sector: number = firstDirSector;
  let guard = 0;

  while (sector < fat.length && guard < 4096 && !visited.has(sector)) {
    visited.add(sector);
    guard += 1;
    const offset = sectorOffset(sector, sectorSize);
    if (offset + sectorSize > buffer.length) break;

    for (let entry = 0; entry + 128 <= sectorSize; entry += 128) {
      const base = offset + entry;
      const nameLength = buffer.readUInt16LE(base + 64);
      const objectType = buffer.readUInt8(base + 66);
      // 2 = stream. Storages (1) and the root (5) are not what we are after.
      if (objectType !== 2 || nameLength < 2 || nameLength > 64) continue;
      const name = buffer.subarray(base, base + nameLength - 2).toString('utf16le');
      if (!name) continue;
      streams.set(name, {
        startSector: buffer.readUInt32LE(base + 116),
        size: Number(buffer.readBigUInt64LE(base + 120)),
      });
    }
    sector = fat[sector] ?? 0xfffffffe;
  }

  return { streams, sectorSize, miniCutoff };
}

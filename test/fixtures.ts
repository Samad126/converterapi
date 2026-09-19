/**
 * Binary fixtures built in code rather than checked in.
 *
 * The interesting cases here are the password-protected ones, and there is no
 * way to produce those without either a copy of Word or a binary blob in the
 * repository. An OLE/CFB container is simple enough to write by hand, and
 * building it here documents exactly what the detector is looking for.
 */

const SECTOR_SIZE = 512;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;

/**
 * Build an OLE/CFB container holding the given streams.
 *
 * Layout: sector 0 is the FAT, sector 1 the directory, and streams follow.
 * Deliberately limited to one FAT sector and one directory sector (<= 127 data
 * sectors, <= 3 streams) - plenty for a fixture, and it keeps this short enough
 * to read.
 */
export function buildCfb(streams: Array<{ name: string; data: Buffer }>): Buffer {
  if (streams.length > 3) throw new Error('fixture builder supports at most 3 streams');

  const dataSectors: Array<{ start: number; count: number }> = [];
  let nextSector = 2; // 0 = FAT, 1 = directory
  for (const stream of streams) {
    const count = Math.max(1, Math.ceil(stream.data.length / SECTOR_SIZE));
    dataSectors.push({ start: nextSector, count });
    nextSector += count;
  }
  const totalSectors = nextSector;
  if (totalSectors > 127) throw new Error('fixture too large for a single FAT sector');

  const file = Buffer.alloc(SECTOR_SIZE + totalSectors * SECTOR_SIZE, 0);

  // --- Header ---------------------------------------------------------------
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x003e, 0x18); // minor version
  file.writeUInt16LE(0x0003, 0x1a); // major version (512-byte sectors)
  file.writeUInt16LE(0xfffe, 0x1c); // little-endian marker
  file.writeUInt16LE(9, 0x1e); // sector shift -> 512
  file.writeUInt16LE(6, 0x20); // mini sector shift
  file.writeUInt32LE(0, 0x28); // number of directory sectors (v3: unused)
  file.writeUInt32LE(1, 0x2c); // number of FAT sectors
  file.writeUInt32LE(1, 0x30); // first directory sector
  file.writeUInt32LE(0, 0x34); // transaction signature
  file.writeUInt32LE(4096, 0x38); // mini stream cutoff
  file.writeUInt32LE(ENDOFCHAIN, 0x3c); // first mini FAT sector
  file.writeUInt32LE(0, 0x40); // number of mini FAT sectors
  file.writeUInt32LE(ENDOFCHAIN, 0x44); // first DIFAT sector
  file.writeUInt32LE(0, 0x48); // number of DIFAT sectors
  file.writeUInt32LE(0, 0x4c); // DIFAT[0] -> FAT lives in sector 0
  for (let i = 1; i < 109; i += 1) file.writeUInt32LE(FREESECT, 0x4c + i * 4);

  // --- FAT ------------------------------------------------------------------
  const fat = new Array<number>(128).fill(FREESECT);
  fat[0] = FATSECT;
  fat[1] = ENDOFCHAIN; // one directory sector
  dataSectors.forEach(({ start, count }) => {
    for (let i = 0; i < count - 1; i += 1) fat[start + i] = start + i + 1;
    fat[start + count - 1] = ENDOFCHAIN;
  });
  const fatOffset = SECTOR_SIZE;
  fat.forEach((value, index) => file.writeUInt32LE(value, fatOffset + index * 4));

  // --- Directory ------------------------------------------------------------
  const dirOffset = SECTOR_SIZE * 2;
  writeDirectoryEntry(file, dirOffset, 'Root Entry', 5, ENDOFCHAIN, 0);
  streams.forEach((stream, index) => {
    const { start } = dataSectors[index]!;
    writeDirectoryEntry(file, dirOffset + (index + 1) * 128, stream.name, 2, start, stream.data.length);
  });

  // --- Stream data ----------------------------------------------------------
  streams.forEach((stream, index) => {
    const { start } = dataSectors[index]!;
    stream.data.copy(file, SECTOR_SIZE + start * SECTOR_SIZE);
  });

  return file;
}

function writeDirectoryEntry(
  file: Buffer,
  offset: number,
  name: string,
  objectType: number,
  startSector: number,
  size: number,
): void {
  const nameBuffer = Buffer.from(`${name}\0`, 'utf16le');
  nameBuffer.copy(file, offset);
  file.writeUInt16LE(nameBuffer.length, offset + 64); // includes the null
  file.writeUInt8(objectType, offset + 66);
  file.writeUInt8(1, offset + 67); // colour: black
  file.writeUInt32LE(FREESECT, offset + 68); // left sibling
  file.writeUInt32LE(FREESECT, offset + 72); // right sibling
  file.writeUInt32LE(FREESECT, offset + 76); // child
  file.writeUInt32LE(startSector, offset + 116);
  file.writeBigUInt64LE(BigInt(size), offset + 120);
}

/**
 * An encrypted OOXML package, the way Word produces one: ECMA-376 encryption
 * wraps the whole package in a CFB container with an `EncryptedPackage` stream,
 * so an encrypted .docx stops being a zip.
 */
export function buildEncryptedDocxContainer(): Buffer {
  return buildCfb([
    { name: 'EncryptionInfo', data: Buffer.alloc(256, 0x04) },
    { name: 'EncryptedPackage', data: Buffer.alloc(1024, 0x5a) },
  ]);
}

/**
 * A legacy .doc that carries the FIB's `fEncrypted` flag.
 *
 * The WordDocument stream has to be at least the mini-stream cutoff (4096) or
 * it would live in the mini-FAT instead, so it is padded to exactly that.
 */
export function buildEncryptedLegacyDoc(): Buffer {
  const wordDocument = Buffer.alloc(4096, 0);
  wordDocument.writeUInt16LE(0xa5ec, 0); // wIdent: it really is a Word FIB
  wordDocument.writeUInt16LE(0x00c1, 2); // nFib
  wordDocument.writeUInt16LE(0x0100, 10); // fibBase flags: fEncrypted
  return buildCfb([{ name: 'WordDocument', data: wordDocument }]);
}

/** A legacy .doc whose FIB is present and clean. */
export function buildPlainLegacyDoc(): Buffer {
  const wordDocument = Buffer.alloc(4096, 0);
  wordDocument.writeUInt16LE(0xa5ec, 0);
  wordDocument.writeUInt16LE(0x00c1, 2);
  wordDocument.writeUInt16LE(0x0000, 10); // no fEncrypted, no fObfuscated
  return buildCfb([{ name: 'WordDocument', data: wordDocument }]);
}

/**
 * A minimal but structurally real PDF whose CURRENT trailer names an
 * `/Encrypt` dictionary.
 *
 * `startxref` genuinely points at a real `xref` section, which genuinely is
 * followed by a `trailer` dictionary holding `/Encrypt` - `pdfLooksEncrypted`
 * follows exactly that path rather than searching the file blindly, so the
 * fixture has to be a real (if tiny) instance of the structure it reads, not
 * just the token, somewhere in the bytes.
 */
export function buildEncryptedPdfContainer(): Buffer {
  const header = '%PDF-1.4\n';
  const object = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xrefOffset = Buffer.byteLength(header + object, 'latin1');
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = 'trailer\n<< /Size 2 /Root 1 0 R /Encrypt 2 0 R >>\n';
  const footer = `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(header + object + xref + trailer + footer, 'latin1');
}

/**
 * A PDF that WAS encrypted, then re-saved without a password - the shape of
 * the false positive that a whole-file `/Encrypt` search used to produce.
 *
 * The file holds two revisions, as an incrementally-updated PDF genuinely
 * would: an original one whose trailer names `/Encrypt`, and a second one
 * appended after it whose trailer does not. `startxref` points at the
 * SECOND, current xref section, so a correct reader has to conclude "not
 * encrypted" even though the literal bytes "/Encrypt" are still sitting
 * earlier in the file, in a trailer that no longer governs anything.
 */
export function buildFormerlyEncryptedPdf(): Buffer {
  const header = '%PDF-1.4\n';
  const object = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const firstXrefOffset = Buffer.byteLength(header + object, 'latin1');
  const firstXref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  // The revision that is no longer current: its trailer names /Encrypt, and
  // its own startxref is never followed by anything - it exists only to
  // plant the stale bytes a naive detector would find.
  const firstTrailer = 'trailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\n';
  const firstFooter = `startxref\n${firstXrefOffset}\n%%EOF\n`;

  const secondXrefOffset = Buffer.byteLength(
    header + object + firstXref + firstTrailer + firstFooter,
    'latin1',
  );
  const secondXref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  // The CURRENT trailer: same document, password removed.
  const secondTrailer = 'trailer\n<< /Size 2 /Root 1 0 R >>\n';
  const secondFooter = `startxref\n${secondXrefOffset}\n%%EOF`;

  return Buffer.from(
    header + object + firstXref + firstTrailer + firstFooter + secondXref + secondTrailer + secondFooter,
    'latin1',
  );
}

/**
 * A .docx whose bytes are a broken package: the ZIP local header promises a
 * document but nothing behind it parses.
 *
 * Note that a plain text file renamed to .docx is NOT a good malformed fixture:
 * LibreOffice sniffs content, imports it as Writer text, and produces a valid
 * PDF. Only something that fails the import filter gives the 500 we are testing.
 */
export function buildMalformedDocx(): Buffer {
  const header = Buffer.from('PK\x03\x04', 'latin1');
  return Buffer.concat([header, Buffer.alloc(4096, 0x07)]);
}

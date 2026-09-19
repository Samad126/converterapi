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
 * Only the OOXML and Word binary formats are inspected. An encrypted ODF file
 * (.odt/.ods/.odp) or an encrypted PDF is left to soffice, which reports those
 * the same way it reports a damaged file - acceptable, because the formats this
 * check was written for are the ones the client actually sends.
 */
import fsp from 'node:fs/promises';

/** Best-effort encryption sniffing gives up past this; soffice decides instead. */
const DETECTION_MAX_BYTES = 8 * 1024 * 1024;

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function isPasswordProtected(inputPath: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(inputPath, 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8 || !head.equals(CFB_MAGIC)) {
      // A zip-based package (.docx/.docm) is never encrypted in place, and
      // anything else is not our problem to classify.
      return false;
    }

    const stat = await handle.stat();
    if (stat.size > DETECTION_MAX_BYTES) return false;

    const buffer = await fsp.readFile(inputPath);
    return cfbLooksEncrypted(buffer);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
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

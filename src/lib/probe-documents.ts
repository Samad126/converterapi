/**
 * Tiny, genuinely valid documents built in memory, one per family.
 *
 * These exist so the boot-time warm-up can exercise a real conversion for each
 * pipeline without a binary fixture checked into the repository - and so the
 * tests can do the same. They are real files in real formats: LibreOffice opens
 * each one for real, which is the entire point. A probe that only parses is not
 * a probe.
 *
 * The document text deliberately includes the metric-compatible font names, so
 * a warm-up log line is also a weak signal that font substitution is working.
 */
import { crc32, deflateSync } from 'node:zlib';

import { zipStored, type ZipEntry } from './zip.ts';

const PROBE_TEXT = 'Converter warm-up';
const PROBE_FONTS = 'Calibri Cambria Arial Times New Roman Courier New 0123456789';

// ---------------------------------------------------------------------------
// Writer: a minimal .docx
// ---------------------------------------------------------------------------

/**
 * Build a real OOXML package: a ZIP of the required parts.
 *
 * A valid .docx needs exactly these four parts - content types, the package
 * relationships, the document relationships and the document body - which is
 * why this stays readable rather than needing a document library.
 */
export function buildMinimalDocx(paragraphs: readonly string[]): Buffer {
  return buildDocxPackage(paragraphs.map(paragraph).join(''));
}

function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function cell(text: string): string {
  return `<w:tc>${paragraph(text)}</w:tc>`;
}

/**
 * A Word document holding one small table, for the `tables` warm-up case.
 *
 * A probe for the extract pipeline cannot reuse the paragraph-only one: a
 * document with no tables is a legitimate 422, so warming up with it would
 * fail the boot check on a perfectly healthy service. This has a header row
 * and two data rows rather than a single cell, because a workbook produced
 * from one cell and a workbook produced from nothing are the same size as far
 * as a byte count can tell.
 */
export function tablesProbe(): Buffer {
  const rows = [
    ['Header', 'Value'],
    ['alpha', '1'],
    ['beta', '2'],
  ]
    .map((values) => `<w:tr>${values.map(cell).join('')}</w:tr>`)
    .join('');

  return buildDocxPackage(`<w:tbl>${rows}</w:tbl><w:p/>`);
}

function buildDocxPackage(body: string): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return zipStored([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/** The standard writer probe: a paragraph naming the fonts pagination depends on. */
export function writerProbe(): Buffer {
  return buildMinimalDocx([PROBE_TEXT, PROBE_FONTS]);
}

// ---------------------------------------------------------------------------
// Calc: a minimal .csv
// ---------------------------------------------------------------------------

/**
 * A three-column, three-row sheet.
 *
 * CSV needs no container at all, which is why it is the probe for the Calc
 * family: it exercises the same import path a real spreadsheet takes without
 * hand-building a ZIP of sheet XML that nothing else in the service needs.
 */
export function calcProbe(): Buffer {
  return Buffer.from(
    ['name,qty,price', 'widget,3,9.99', 'gadget,12,1.5'].join('\n') + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Impress: a minimal .odp
// ---------------------------------------------------------------------------

const ODF_NAMESPACES = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"`;

/**
 * Two slides in one ODP package.
 *
 * Two, specifically: this is the probe for the raster pipeline, and two slides
 * is the smallest deck that proves we get one image PER SLIDE rather than one
 * image for the first slide - which is exactly the distinction LibreOffice's
 * own command-line image export gets wrong.
 *
 * Hand-built rather than a checked-in binary so the repository stays free of
 * fixtures nobody can read, and so the tests have a real Impress document to
 * upload. An ODF package needs four parts: the `mimetype` entry (which must be
 * the FIRST entry in the archive and STORED, not deflated - that is how a
 * consumer recognises an ODF file from the first bytes), the manifest, and the
 * content and styles documents.
 */
export function buildMinimalOdp(slideTexts: readonly string[]): Buffer {
  const pages = slideTexts
    .map(
      (text, index) => `<draw:page draw:name="page${index + 1}" draw:master-page-name="Default">
   <draw:frame svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="2cm">
    <draw:text-box><text:p>${escapeXml(text)}</text:p></draw:text-box>
   </draw:frame>
  </draw:page>`,
    )
    .join('\n  ');

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_NAMESPACES} office:version="1.2"><office:body><office:presentation>
  ${pages}
</office:presentation></office:body></office:document-content>`;

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ODF_NAMESPACES} office:version="1.2">
 <office:automatic-styles><style:page-layout style:name="PL1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles>
 <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PL1"/></office:master-styles>
</office:document-styles>`;

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  return zipStored([
    // Order matters: `mimetype` first, and zipStored never deflates.
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.presentation') },
    { name: 'META-INF/manifest.xml', data: Buffer.from(manifest, 'utf8') },
    { name: 'content.xml', data: Buffer.from(content, 'utf8') },
    { name: 'styles.xml', data: Buffer.from(styles, 'utf8') },
  ]);
}

/** The standard impress probe: two slides, the second proving we got them both. */
export function impressProbe(): Buffer {
  return buildMinimalOdp([`${PROBE_TEXT} - ${PROBE_FONTS}`, 'Second slide']);
}

// ---------------------------------------------------------------------------
// A minimal PNG, for tests of the raster pipeline's output checks
// ---------------------------------------------------------------------------

/** A solid-colour PNG of the given size, built from scratch (no image library). */
export function buildSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  // Raw scanlines: one filter byte (0 = none) followed by RGB triples.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Re-exported so callers do not need both zip helpers. */
export type { ZipEntry };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

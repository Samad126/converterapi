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
import { assemblePng } from './png.ts';
import { writePsd } from './psd.ts';
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

/**
 * A solid-colour PNG of the given size, built from scratch (no image library).
 *
 * Truecolour without alpha, unlike the layer extractor's output, because this
 * exists to be a `.png` for the raster and Draw pipelines to import - and it is
 * also the fixture a test uploads to prove the service accepts a PNG at all.
 * The chunk framing is shared with `png.ts` so that the two writers cannot
 * disagree about how a PNG is put together.
 */
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

  return assemblePng(width, height, 8, 2, raw);
}

// ---------------------------------------------------------------------------
// Layers: a minimal .psd
// ---------------------------------------------------------------------------

/** A solid RGBA block, as ag-psd reads and writes layer pixels. */
function solidPixels(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

/**
 * How many of `psdProbe`'s layers have pixels that become files.
 *
 * Exported rather than counted at the call site, because the number is only
 * meaningful as a fact about the probe: the boot check asserts the extraction
 * produces exactly this many images, and writing the figure out in two places
 * is how a probe and the check that guards it drift apart.
 */
export const PSD_PROBE_DRAWABLE_LAYERS = 3;

/**
 * A Photoshop document whose layers exercise the counting rule.
 *
 * Written with ag-psd's own writer, which is the only way to get a real PSD
 * into a repository that does not want binary fixtures - and it is a genuine
 * one: the reader has to walk a real layer section, with real records, real
 * channel lengths and real group dividers, so the bounds pass in `psd-layers.ts`
 * is exercised for real rather than against a hand-made approximation.
 *
 * Three drawable layers, chosen so that the number of files depends on every
 * rule at once - the way the ODP probe has two slides for the same reason:
 *
 *   Buttons/Normal   in a group - the group is a directory, not a file
 *   Buttons/Hover    in a group, and hidden - still a file
 *   Background       at the top level
 *   Levels           no pixels - NOT a file
 *
 * So the answer is three, and it is three only if a group is not counted, a
 * hidden layer is, and an empty one is not. Get any of those wrong and the
 * extraction still succeeds, with the wrong number of files, and nothing else
 * in the system would notice: every file is a valid PNG in a valid archive.
 */
export function psdProbe(): Buffer {
  const document = {
    width: 16,
    height: 16,
    children: [
      {
        name: 'Buttons',
        children: [
          { name: 'Normal', left: 0, top: 0, right: 8, bottom: 8, imageData: solidPixels(8, 8, [200, 40, 40, 255]) },
          { name: 'Hover', left: 0, top: 0, right: 8, bottom: 8, imageData: solidPixels(8, 8, [40, 120, 220, 255]), hidden: true },
        ],
      },
      { name: 'Background', left: 0, top: 0, right: 16, bottom: 16, imageData: solidPixels(16, 16, [16, 16, 16, 255]) },
      // No pixel data, like an adjustment or text layer. Nothing to write, and
      // it must not be counted as a file.
      { name: 'Levels', left: 0, top: 0, right: 0, bottom: 0, imageData: { width: 0, height: 0, data: new Uint8ClampedArray(0) } },
    ],
  };

  // The cast is ag-psd's: its `Psd` type describes a document it has read, with
  // every optional field present, while the writer accepts the subset it needs.
  return Buffer.from(writePsd(document as never, { generateThumbnail: false }));
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

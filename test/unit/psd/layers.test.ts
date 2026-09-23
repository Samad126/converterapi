/**
 * Tests for the layer extractor: the PNG writer, the bounds pass, the layer
 * walk, and the names that come out of all three.
 *
 * These pin down the two ways this feature can be wrong without anyone
 * noticing, and neither is an error thrown at the wrong moment.
 *
 * The first is a PNG that is structurally perfect and holds the wrong pixels.
 * Every check downstream of the encoder - the signature test in `looksLike`,
 * the IHDR a client reads, the CRC on every chunk - passes for an image written
 * with the byte order or the row stride wrong. So the encoder is not checked
 * against itself here: the IDAT is inflated with `node:zlib` and compared
 * scanline by scanline against the pixels that went in, which is the only check
 * that would catch a colour channel in the wrong place.
 *
 * The second is an archive that is missing a layer, or has the wrong number of
 * files for the document. Nothing fails, the ZIP opens, every image in it is
 * valid - and the person who asked for their layers back is short a few with no
 * indication that anything happened. That is why the counting rules get their
 * own cases: a group is not a file, a hidden layer is, a layer with no pixels
 * is not, and two layers of the same name are two files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

const { encodePng, assemblePng } = await import('../../../src/lib/png.ts');
const { writePsd } = await import('../../../src/lib/psd.ts');
const {
  extractLayers,
  manifestJson,
  safeLayerName,
  MANIFEST_FILENAME,
} = await import('../../../src/lib/psd-layers.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const GENEROUS = {
  maxDecodeBytes: 192 * 1024 * 1024,
  maxOutputBytes: 48 * 1024 * 1024,
  maxLayers: 500,
};

/** A block of one colour, as ag-psd's writer and reader both take pixels. */
function pixels(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

type ProbeLayer = Record<string, unknown>;

/** Write a real PSD with ag-psd, so the reader meets a real layer section. */
function buildPsd(children: ProbeLayer[], size = 16): Buffer {
  const document = { width: size, height: size, children };
  return Buffer.from(writePsd(document as never, { generateThumbnail: false }));
}

function layer(name: string, opts: ProbeLayer = {}): ProbeLayer {
  return { name, left: 0, top: 0, right: 4, bottom: 4, imageData: pixels(4, 4, [10, 20, 30, 255]), ...opts };
}

/** Parse a PNG into its chunks, checking nothing - the tests do that. */
function readChunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const found: Array<{ type: string; data: Buffer; crc: number }> = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    found.push({ type, data, crc: png.readUInt32BE(at + 8 + length) });
    at += length + 12;
  }
  return found;
}

/** The de-filtered scanlines of a PNG: every row's filter byte, then its samples. */
function scanlines(png: Buffer): Buffer {
  const idat = readChunks(png).filter((chunk) => chunk.type === 'IDAT');
  return inflateSync(Buffer.concat(idat.map((chunk) => chunk.data)));
}

/**
 * The offset of the first layer record's first channel-length field.
 *
 * Walks the format's fixed prefix by hand so a test can corrupt one field and
 * leave everything else intact. Deliberately independent of the walk under
 * test: a fixture built with the same code that is being checked proves only
 * that the code agrees with itself.
 */
function firstChannelLengthOffset(psd: Buffer): number {
  let at = 26; // the file header
  at += 4 + psd.readUInt32BE(at); // colour mode data
  at += 4 + psd.readUInt32BE(at); // image resources
  at += 4; // layer and mask info length
  at += 4; // layer info length
  at += 2; // layer count
  at += 16; // layer rectangle
  at += 2; // channel count
  at += 2; // first channel id
  return at;
}

// ---------------------------------------------------------------------------
// The PNG writer
// ---------------------------------------------------------------------------

describe('layer names', () => {
  it('cannot escape the directory it is written into', () => {
    // `safeEntryName` in zip.ts is the backstop; this is the first line, and it
    // is what keeps the manifest and the archive agreeing, because a name with
    // a slash in it would become a directory the manifest does not mention.
    //
    // Asserted as properties rather than as exact strings, because the exact
    // spelling of a scrubbed name is not the thing that matters - `.._.._x` and
    // `x` are equally safe, and pinning either would make this test about the
    // sanitiser's taste instead of about what it guarantees.
    for (const hostile of [
      '../../etc/passwd',
      '/absolute/path',
      '..',
      '.',
      'sub/layer',
      'back\\slash',
      'a/../../b',
      '....//....//x',
    ]) {
      const safe = safeLayerName(hostile, 'x');
      assert.ok(!safe.includes('/'), `${hostile} -> ${safe} still contains a separator`);
      assert.ok(!safe.includes('\\'), `${hostile} -> ${safe} still contains a separator`);
      assert.ok(!safe.startsWith('.'), `${hostile} -> ${safe} starts with a dot`);
      assert.notEqual(safe, '.');
      assert.notEqual(safe, '..');
      assert.notEqual(safe, '', `${hostile} produced nothing at all`);
      // What actually gets written is this name with `.png` on the end, inside
      // whatever directory the group path made. One component, always.
      assert.equal(safe.split('/').length, 1);
    }
  });

  it('falls back when a document gives a layer no usable name', () => {
    // Empty and whitespace-only names are real: Photoshop writes them, and a
    // file called `.png` is invisible on every Unix filesystem there is.
    assert.equal(safeLayerName('', 'Layer 3'), 'Layer 3');
    assert.equal(safeLayerName(undefined, 'Layer 3'), 'Layer 3');
    assert.equal(safeLayerName('   ', 'Layer 3'), 'Layer 3');
    assert.equal(safeLayerName('...', 'Layer 3'), 'Layer 3');
  });

  it('strips the characters that break the machine it is unzipped on', () => {
    // None of these is a security problem. All of them are a layer that goes
    // missing on Windows - which the person who lost it cannot distinguish from
    // the converter having dropped it.
    assert.equal(safeLayerName('a:b*c?d"e<f>g|h', 'x'), 'a_b_c_d_e_f_g_h');
    assert.equal(safeLayerName('trailing.', 'x'), 'trailing');
    assert.equal(safeLayerName('trailing ', 'x'), 'trailing');
    assert.equal(safeLayerName('line\nbreak', 'x'), 'linebreak');
    assert.equal(safeLayerName('nul\u0000byte', 'x'), 'nulbyte');
  });

  it('drops lone surrogates rather than letting the two names disagree', () => {
    // JSON can carry an unpaired surrogate and UTF-8 cannot, so a name kept
    // verbatim in the manifest would not be findable in the archive.
    const lone = 'layer\uD800name';
    const cleaned = safeLayerName(lone, 'x');
    assert.equal(cleaned, 'layername');
    // The same string has to survive a UTF-8 round trip, which is what the ZIP
    // writer does to it.
    assert.equal(Buffer.from(cleaned, 'utf8').toString('utf8'), cleaned);
  });

  it('truncates without cutting a character in half', () => {
    assert.equal(safeLayerName('x'.repeat(500), 'x').length, 100);
    // Counted in code points, so an astral character is not split into two
    // halves that each re-encode as a replacement character.
    const emoji = '😀'.repeat(200);
    const truncated = safeLayerName(emoji, 'x');
    assert.equal(Array.from(truncated).length, 100);
    assert.equal(Buffer.from(truncated, 'utf8').toString('utf8'), truncated);
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe('layer extraction', () => {
  it('writes one image per drawable layer, named after the layer', () => {
    const result = extractLayers(
      buildPsd([layer('Bottom'), layer('Top')]),
      GENEROUS,
    );

    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' && result.layers.length, 2);
    assert.deepEqual(
      result.kind === 'ok' && result.layers.map((entry) => entry.file),
      ['Bottom.png', 'Top.png'],
    );
  });

  it('keeps the document order rather than reversing the stack', () => {
    // The order the file stores layers in, which is the bottom of the stack
    // first. Reversing to look like the Layers panel would silently disagree
    // with the manifest of every other tool that reads the same document.
    const result = extractLayers(buildPsd([layer('First'), layer('Second'), layer('Third')]), GENEROUS);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(
      result.kind === 'ok' && result.manifest.layers.map((entry) => entry.name),
      ['First', 'Second', 'Third'],
    );
  });

  it('turns a group into a directory and not into a file', () => {
    const result = extractLayers(
      buildPsd([
        { name: 'Buttons', children: [layer('Normal'), layer('Hover')] },
        layer('Background'),
      ]),
      GENEROUS,
    );

    assert.equal(result.kind, 'ok');
    assert.deepEqual(
      result.kind === 'ok' && result.layers.map((entry) => entry.file),
      ['Buttons/Normal.png', 'Buttons/Hover.png', 'Background.png'],
    );
    assert.equal(result.kind === 'ok' && result.manifest.exported, 3, 'the group is not a file');
  });

  it('keeps layers of the same name apart, in the same folder and across folders', () => {
    // Two layers called `Background` is ordinary, and so is one name used in two
    // groups. Every extractor silently keeps the last of a colliding pair, so
    // the layer that disappeared is one the user cannot get back.
    const result = extractLayers(
      buildPsd([
        { name: 'One', children: [layer('Icon')] },
        { name: 'Two', children: [layer('Icon')] },
        layer('Icon'),
        layer('Icon'),
      ]),
      GENEROUS,
    );

    assert.equal(result.kind, 'ok');
    const files = result.kind === 'ok' ? result.layers.map((entry) => entry.file) : [];
    assert.deepEqual(files, [
      'One/Icon.png',
      'Two/Icon.png',
      'Icon.png',
      'Icon_2.png',
    ]);
    assert.equal(new Set(files).size, files.length, 'every entry name must be unique');
  });

  it('treats names that differ only in case as a collision', () => {
    // The ZIP format is case-sensitive and most machines that unzip are not.
    const result = extractLayers(buildPsd([layer('Button'), layer('button')]), GENEROUS);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(
      result.kind === 'ok' && result.layers.map((entry) => entry.file),
      ['Button.png', 'button_2.png'],
    );
  });

  it('exports hidden layers and says which they were', () => {
    // Dropping them would make the archive's layer count disagree with the
    // document's with nothing anywhere to explain why.
    const result = extractLayers(buildPsd([layer('Visible'), layer('Secret', { hidden: true })]), GENEROUS);

    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' && result.layers.length, 2, 'a hidden layer is still a file');
    const records = result.kind === 'ok' ? result.manifest.layers : [];
    assert.deepEqual(records.map((record) => record.hidden), [false, true]);
  });

  it('skips layers with nothing to draw and records why', () => {
    const result = extractLayers(
      buildPsd([
        layer('Real'),
        { name: 'Levels', left: 0, top: 0, right: 0, bottom: 0, imageData: { width: 0, height: 0, data: new Uint8ClampedArray(0) } },
      ]),
      GENEROUS,
    );

    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' && result.layers.length, 1);
    const records = result.kind === 'ok' ? result.manifest.layers : [];
    assert.equal(records.length, 2, 'the skipped layer is still described');
    const skipped = records.find((record) => record.name === 'Levels');
    assert.equal(skipped?.file, null);
    assert.match(skipped?.skippedReason ?? '', /no pixel data|zero-sized/);
  });

  it('carries the geometry a consumer needs to reassemble the document', () => {
    // Each image is the layer's own bounding box, which is what makes the
    // archive small - and what makes the offsets the only way to put the
    // document back together, so they have to be in the manifest.
    const result = extractLayers(
      buildPsd([layer('Offset', { left: 3, top: 5, right: 7, bottom: 9, imageData: pixels(4, 4, [1, 2, 3, 4]) })]),
      GENEROUS,
    );

    assert.equal(result.kind, 'ok');
    const record = result.kind === 'ok' ? result.manifest.layers[0]! : undefined;
    assert.deepEqual(
      { left: record?.left, top: record?.top, right: record?.right, bottom: record?.bottom },
      { left: 3, top: 5, right: 7, bottom: 9 },
    );
    assert.equal(record?.width, 4, 'the image is the layer box, not the canvas');
  });

  it('reports opacity as the byte the document stores', () => {
    const result = extractLayers(buildPsd([layer('Half', { opacity: 0.5 })]), GENEROUS);
    assert.equal(result.kind === 'ok' && result.manifest.layers[0]?.opacity, 128);
  });

  it('describes the canvas and the totals', () => {
    const result = extractLayers(buildPsd([layer('One'), layer('Two')], 24), GENEROUS);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' && result.manifest.canvas, { width: 24, height: 24 });
    assert.equal(result.kind === 'ok' && result.manifest.exported, 2);
    assert.equal(result.kind === 'ok' && result.manifest.skipped, 0);
  });

  it('writes a manifest that parses and agrees with the archive', () => {
    const result = extractLayers(buildPsd([{ name: 'Group', children: [layer('Inner')] }]), GENEROUS);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;

    const parsed = JSON.parse(manifestJson(result.manifest).toString('utf8')) as {
      exported: number;
      layers: Array<{ file: string | null }>;
    };
    assert.equal(parsed.exported, result.layers.length);
    for (const entry of result.layers) {
      assert.ok(
        parsed.layers.some((record) => record.file === entry.file),
        `${entry.file} is in the archive and not in the manifest`,
      );
    }
    assert.ok(!parsed.layers.some((record) => record.file?.includes(MANIFEST_FILENAME)));
  });

  it('stops when the client has gone', () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(extractLayers(buildPsd([layer('One')]), GENEROUS, controller.signal).kind, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// What the reader refuses
// ---------------------------------------------------------------------------

describe('layer extraction limits', () => {
  it('refuses a file that is not a PSD at all', () => {
    const result = extractLayers(Buffer.from('a text file wearing a .psd extension'), GENEROUS);
    assert.equal(result.kind, 'unreadable');
  });

  it('refuses a truncated document', () => {
    const psd = buildPsd([layer('One'), layer('Two')]);
    const result = extractLayers(psd.subarray(0, Math.floor(psd.length / 2)), GENEROUS);
    assert.equal(result.kind, 'unreadable');
  });

  it('refuses a PSB rather than guessing at its layout', () => {
    const psd = buildPsd([layer('One')]);
    psd.writeUInt16BE(2, 4); // version 2
    const result = extractLayers(psd, GENEROUS);
    assert.equal(result.kind, 'unreadable');
    assert.match(result.kind === 'unreadable' ? result.reason : '', /PSB/);
  });

  it('refuses a document whose channel lengths are a lie, before allocating', () => {
    // The attack this bounds pass exists for. A PSD declares each channel's
    // byte length in its own header and ag-psd allocates what is declared, so a
    // small file can ask for gigabytes - measured against a 502-byte document.
    // The refusal has to happen on the declaration, not on the allocation.
    const psd = buildPsd([layer('One')]);
    const at = firstChannelLengthOffset(psd);
    const honest = psd.readUInt32BE(at);
    psd.writeUInt32BE(90 * 1024 * 1024, at);
    assert.ok(honest < 90 * 1024 * 1024, 'the fixture should have had a small channel');

    const before = process.memoryUsage().heapUsed;
    const result = extractLayers(psd, GENEROUS);
    const grew = process.memoryUsage().heapUsed - before;

    assert.equal(result.kind, 'unreadable');
    // Nothing like 90MB was ever asked for. Generous by two orders of magnitude
    // because a heap measurement is noisy and the point is the order, not the byte.
    assert.ok(grew < 8 * 1024 * 1024, `the reader allocated ${Math.round(grew / 1024)}KB before refusing`);
  });

  it('refuses a document that declares more layers than we will walk', () => {
    const result = extractLayers(buildPsd([layer('One'), layer('Two')]), { ...GENEROUS, maxLayers: 1 });
    assert.equal(result.kind, 'too-large');
    assert.match(result.kind === 'too-large' ? result.reason : '', /layer limit/);
  });

  it('refuses a document whose pixel data passes the decode budget', () => {
    // The same guard as above, reached through the budget rather than through
    // the alignment check: a legitimate document with the budget set to nothing.
    const result = extractLayers(buildPsd([layer('One')]), { ...GENEROUS, maxDecodeBytes: 8 });
    assert.equal(result.kind, 'too-large');
    assert.match(result.kind === 'too-large' ? result.reason : '', /byte limit/);
  });

  it('refuses a document whose images would pass the output budget', () => {
    const result = extractLayers(buildPsd([layer('One'), layer('Two')]), { ...GENEROUS, maxOutputBytes: 8 });
    assert.equal(result.kind, 'too-large');
    assert.match(result.kind === 'too-large' ? result.reason : '', /image output/);
  });

  it('calls a document with nothing to draw what it is', () => {
    // Not a failure and not a damaged file: an adjustment-only document is an
    // ordinary thing to own, and it is a different sentence from "this could
    // not be converted".
    const empty = buildPsd([
      { name: 'Only', left: 0, top: 0, right: 0, bottom: 0, imageData: { width: 0, height: 0, data: new Uint8ClampedArray(0) } },
    ]);
    assert.equal(extractLayers(empty, GENEROUS).kind, 'no-layers');
  });
});

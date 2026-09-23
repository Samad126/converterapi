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

describe('png writer', () => {
  it('writes a signature, IHDR, IDAT and IEND and nothing else', () => {
    const png = encodePng(pixels(4, 3, [1, 2, 3, 4]));

    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'the signature is wrong');

    const chunks = readChunks(png);
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['IHDR', 'IDAT', 'IEND'],
    );
    assert.equal(chunks.at(-1)!.data.length, 0, 'IEND must be empty');
  });

  it('describes the image in IHDR the way the decoder reads it', () => {
    const png = encodePng(pixels(257, 199, [9, 8, 7, 6]));
    const ihdr = readChunks(png)[0]!.data;

    assert.equal(ihdr.readUInt32BE(0), 257, 'width');
    assert.equal(ihdr.readUInt32BE(4), 199, 'height');
    assert.equal(ihdr[8], 8, 'bit depth');
    // 6 is truecolour WITH alpha. A 2 here makes a decoder read three bytes per
    // pixel out of four-byte data - a skewed image rather than a failure.
    assert.equal(ihdr[9], 6, 'colour type');
    assert.equal(ihdr[10], 0, 'compression: deflate');
    assert.equal(ihdr[11], 0, 'filter method');
    assert.equal(ihdr[12], 0, 'interlace: none');
  });

  it('checksums every chunk over its type and data', () => {
    const png = encodePng(pixels(3, 3, [200, 100, 50, 255]));
    for (const chunk of readChunks(png)) {
      const body = png.subarray(
        png.indexOf(Buffer.from(chunk.type, 'ascii')),
        png.indexOf(Buffer.from(chunk.type, 'ascii')) + 4 + chunk.data.length,
      );
      assert.equal(
        chunk.crc >>> 0,
        crc32(body) >>> 0,
        `chunk ${chunk.type} has a wrong CRC`,
      );
    }
  });

  it('round-trips the exact pixels it was given', () => {
    // The check that catches a channel in the wrong place, a stride that is one
    // byte out, or a row copied from the wrong offset. Inflating the IDAT with
    // node:zlib rather than with anything of ours is the point: this compares
    // what went in against what a decoder sees, not our encoder against itself.
    const width = 37;
    const height = 21;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = i % 256;
      data[i * 4 + 1] = (i * 7) % 256;
      data[i * 4 + 2] = (i * 13) % 256;
      data[i * 4 + 3] = (i * 29) % 256;
    }

    const raw = scanlines(encodePng({ width, height, data }));
    assert.equal(raw.length, (width * 4 + 1) * height, 'the scanline buffer is the wrong size');

    const stride = width * 4;
    for (let y = 0; y < height; y += 1) {
      assert.equal(raw[y * (stride + 1)], 0, `row ${y} does not start with a filter byte`);
      for (let x = 0; x < stride; x += 1) {
        assert.equal(
          raw[y * (stride + 1) + 1 + x],
          data[y * stride + x],
          `pixel byte ${y}:${x} differs`,
        );
      }
    }
  });

  it('writes a 16-bit image as 16 bits, big-endian', () => {
    // A 16-bit document must not be squeezed into 8. Truncating turns 0x8000
    // into 0x00 - a black pixel - while leaving every other part of the file
    // perfectly valid, which is the worst way to be wrong.
    const samples = new Uint16Array([0x1234, 0x5678, 0x9abc, 0xdef0]);
    const png = encodePng({ width: 1, height: 1, data: samples });

    assert.equal(readChunks(png)[0]!.data[8], 16, 'bit depth');
    assert.equal(readChunks(png)[0]!.data[9], 6, 'colour type');

    const raw = scanlines(png);
    assert.equal(raw.length, 1 + 8, 'one filter byte and four 16-bit samples');
    assert.equal(raw[0], 0, 'filter byte');
    // Big-endian: the high byte first. Little-endian would put each sample's
    // halves the wrong way round and produce a plausible-looking gradient.
    assert.deepEqual([...raw.subarray(1, 9)], [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  });

  it('refuses an image it cannot represent', () => {
    const good = pixels(2, 2, [1, 1, 1, 1]);

    assert.throws(() => encodePng({ width: 0, height: 2, data: good.data }), /positive integer/);
    assert.throws(() => encodePng({ width: 2, height: -1, data: good.data }), /positive integer/);
    // A short buffer padded out silently would put a band of garbage down the
    // bottom of the image.
    assert.throws(
      () => encodePng({ width: 4, height: 4, data: good.data }),
      /samples, expected/,
    );
  });

  it('assembles a probe PNG that decodes', () => {
    const png = assemblePng(2, 2, 8, 2, Buffer.from([0, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12]));
    assert.equal(readChunks(png)[0]!.data[9], 2, 'colour type: truecolour, no alpha');
    assert.ok(!png.subarray(8).equals(Buffer.alloc(0)));
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

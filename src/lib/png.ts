/**
 * A minimal PNG writer, for the layer extractor's output.
 *
 * The same reasoning as `zip.ts`: PNG is not worth a dependency when the case
 * we need is this narrow. Everything a layer can be is 8-bit or 16-bit RGBA,
 * full-canvas, non-interlaced, so the file is a signature, one IHDR, one IDAT
 * and one IEND - three chunks and no ancillary data, no palette, no palette
 * entry, no transparency chunk. The encoder is deliberately not general: it
 * refuses anything outside that shape rather than guessing, because the failure
 * mode of a too-clever image encoder is a file that opens and is subtly wrong.
 *
 * Two details are load-bearing and are the ones a hand-written PNG gets wrong:
 *
 *   - THE IDAT IS zlib-WRAPPED, not raw. `deflateSync`, never `deflateRawSync`.
 *     `zip.ts` uses the raw form for ZIP entries because the ZIP format wants
 *     it, and the two functions sit next to each other in node:zlib - but a
 *     raw-deflate IDAT is rejected by every decoder even though the file still
 *     starts with the right eight bytes.
 *   - EVERY SCANLINE IS FILTER-PREFIXED. Each row is one filter byte followed
 *     by that row's samples. Filter 0 ("None") is the whole strategy: the
 *     deflate stage compresses the result well enough, and picking better
 *     filters per row is an optimisation this does not need.
 *
 * The 16-bit path exists because ag-psd hands back `Uint16Array` pixels for a
 * 16-bit document, and PNG supports 16 bits per channel natively. Truncating
 * those to 8 bits - which is what a `Buffer.from(data)` would quietly do -
 * turns every 16-bit midtone into a black pixel while leaving the signature,
 * the IHDR and every CRC perfectly valid. Emitting 16-bit instead is both
 * lossless and no more code; see `psd-layers.ts` for what happens to the one
 * depth PNG cannot represent at all.
 */
import { crc32, deflateSync } from 'node:zlib';

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour type 6: truecolour with an alpha channel, i.e. RGBA. */
const COLOUR_TYPE_RGBA = 6;

/** Samples per pixel. Every image this module writes is RGBA. */
const SAMPLES_PER_PIXEL = 4;

/** Largest value PNG can carry in a width or height field. */
const MAX_DIMENSION = 0x7fffffff;

export interface RgbaImage {
  width: number;
  height: number;
  /**
   * Straight (non-premultiplied) RGBA samples, row-major, four per pixel.
   *
   * `Uint8ClampedArray` and `Uint8Array` are written as 8-bit, `Uint16Array`
   * as 16-bit. `Float32Array` is deliberately NOT accepted: PNG has no
   * floating-point form, ag-psd only produces one for a 32-bit document, and
   * there is no honest 8-bit answer to "what colour is this HDR pixel" - so
   * the refusal belongs to the caller that knows what it is looking at.
   */
  data: Uint8ClampedArray | Uint8Array | Uint16Array;
}

/**
 * Encode an RGBA image as a PNG.
 *
 * Throws on an image this writer cannot represent - a zero or oversized
 * dimension, or a buffer whose length disagrees with the dimensions. Those are
 * faults in the caller, not conditions to paper over: a short buffer silently
 * padded produces a PNG with a band of garbage in it.
 */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG needs positive integer dimensions, got ${width}x${height}`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`PNG dimensions ${width}x${height} exceed the format's limit`);
  }

  const expected = width * height * SAMPLES_PER_PIXEL;
  if (data.length !== expected) {
    throw new Error(
      `PNG pixel buffer is ${data.length} samples, expected ${expected} for ${width}x${height} RGBA`,
    );
  }

  const sixteenBit = data instanceof Uint16Array;
  const bytesPerSample = sixteenBit ? 2 : 1;
  const stride = width * SAMPLES_PER_PIXEL * bytesPerSample;

  // One filter byte per row, then the row's samples.
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None

    if (sixteenBit) {
      // PNG stores 16-bit samples BIG-endian, and a Uint16Array on every
      // platform we run on is little-endian - so this is a byte swap, not a
      // copy. Writing it as a copy is the mistake that produces an image made
      // of the right colours in the wrong order.
      const source = data as Uint16Array;
      const firstSample = y * width * SAMPLES_PER_PIXEL;
      for (let i = 0; i < width * SAMPLES_PER_PIXEL; i += 1) {
        raw.writeUInt16BE(source[firstSample + i]!, rowStart + 1 + i * 2);
      }
    } else {
      // A view, not a copy, so that the row can be copied once into place.
      const source = data as Uint8ClampedArray | Uint8Array;
      Buffer.from(source.buffer, source.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
    }
  }

  return assemblePng(width, height, sixteenBit ? 16 : 8, COLOUR_TYPE_RGBA, raw);
}

/**
 * Assemble a PNG from already-filtered scanlines.
 *
 * Split out because the boot probes build their own fixtures - see
 * `buildSolidPng` in probe-documents.ts - and a second copy of the chunk and
 * CRC machinery is a second place for the IDAT to end up deflated the wrong
 * way. Callers are responsible for `rawScanlines` being correctly filtered and
 * the right length for the depth they name.
 */
export function assemblePng(
  width: number,
  height: number,
  bitDepth: 8 | 16,
  colourType: number,
  rawScanlines: Buffer,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  // Bytes 10-12 stay zero: deflate compression, adaptive filtering, no
  // interlace. Zero is the only value each of them may take in a PNG we write.

  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rawScanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * One PNG chunk: length, type, data, CRC.
 *
 * The CRC covers the type and the data but NOT the length field - the single
 * most common way to get this wrong, and one that produces a file which decodes
 * perfectly until something actually validates it.
 */
export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);

  return Buffer.concat([length, body, crc]);
}

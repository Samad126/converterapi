/**
 * Reading a PSD's layers out, as images.
 *
 * The sibling of `docx-tables.ts`: a reader for one document format that
 * produces something other than a conversion of the whole file. Where that one
 * walks XML, this one hands the bytes to ag-psd and works on the layer tree it
 * gives back - but it opens with a pass over the file's OWN declared structure,
 * which is the part that needs explaining.
 *
 * WHY THERE IS A BOUNDS PASS BEFORE THE PARSER. ag-psd is a faithful reader of
 * an untrusted format, and an untrusted format is exactly what it sounds like:
 * a PSD declares the byte length of every layer channel in its own header, and
 * ag-psd trusts those lengths enough to allocate them. Its byte reader, on
 * finding a declared length that runs past the end of the file, warns and then
 * allocates `new Uint8Array(length)` anyway - up to a 100MB ceiling - and the
 * resulting buffer is retained per channel until that layer is decoded, which
 * happens for every layer only AFTER every layer record has been read. Layer
 * count and channel length are both read straight from the file with no
 * comparison against the file's actual size.
 *
 * So a few hundred kilobytes of carefully arranged PSD can ask for terabytes
 * before any of the pixel data is looked at. On a container with `mem_limit:
 * 1g` that is an OOM kill of the whole service, and an OOM kill reaches the
 * user as a network error rather than as a sentence about their file.
 *
 * The answer is the same one `unzip.ts` uses against a decompression bomb:
 * refuse on what the container DECLARES, before doing the work it would take to
 * find out. `readDeclaredSizes` walks the header and the layer records reading
 * nothing but lengths, allocating nothing, and returns a refusal the moment the
 * declared total passes the budget. It is deliberately strict about
 * structure - a walk that does not land exactly where the format says it
 * should is treated as unreadable rather than guessed at, because guessing is
 * how a bounds check stops bounding anything.
 */
import { encodePng } from './png.ts';
import { readPsd, type Layer, type Psd } from './psd.ts';

/**
 * Aggravating factor for the bounds errors: how much decoded pixel data and how
 * much finished archive we are willing to hold at once. Passed in rather than
 * read from config directly so the caller owns the budget - see `config.ts`.
 */
export interface LayerLimits {
  /** Total bytes of layer pixel data the document may declare. */
  maxDecodeBytes: number;
  /** Total bytes of PNG the extraction may produce. */
  maxOutputBytes: number;
  /** Most layers a document may hold. */
  maxLayers: number;
}

/** One layer as it appears in `manifest.json`. */
export interface LayerRecord {
  /** The name as the document spells it, after sanitising. */
  name: string;
  /** The group path it sat under, `/`-joined, or null at the top level. */
  group: string | null;
  /** Where it was written inside the archive, or null when it was skipped. */
  file: string | null;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Exported like any other layer, but Photoshop was not drawing it. */
  hidden: boolean;
  /** 0-255, as the format stores it. */
  opacity: number;
  /** PNG bytes written; 0 when the layer was skipped. */
  bytes: number;
  /** Why this layer produced no image, or null when it did. */
  skippedReason: string | null;
}

export interface LayersManifest {
  canvas: { width: number; height: number };
  exported: number;
  skipped: number;
  layers: LayerRecord[];
}

export interface ExtractedLayer {
  /** Name inside the archive. */
  file: string;
  data: Buffer;
}

export type LayersExtraction =
  | { kind: 'ok'; layers: ExtractedLayer[]; manifest: LayersManifest }
  /** The document declares more work than we will do. */
  | { kind: 'too-large'; reason: string }
  /** Read fine, but holds nothing to extract. */
  | { kind: 'no-layers'; reason: string }
  /** Not a PSD, or damaged, or structurally inconsistent. */
  | { kind: 'unreadable'; reason: string }
  /** The client left while we were working. */
  | { kind: 'cancelled' };

/** Version 1 is PSD. 2 is PSB, which this reader does not accept. */
const VERSION_PSD = 1;

/** The longest a name may be in the archive, before any de-duplication. */
const MAX_NAME_LENGTH = 100;

/** The `warnOrThrow` ceiling in ag-psd's byte reader; see the header comment. */
const PER_CHANNEL_DECLARED_CEILING = 100 * 1024 * 1024;

/**
 * How far inside the layer section a correct walk may legitimately stop.
 *
 * The section is written with padding to an alignment and its length field
 * counts the padding, so a walk that understood the file lands a few bytes
 * short of the boundary rather than exactly on it. Measured against ag-psd's
 * own writer, which aligns the section to four bytes.
 *
 * Deliberately loose. This bounds only the walk's self-consistency, not the
 * amount of memory a document can ask for - that is decided by whether the
 * declared data fits inside the file at all, and a document cannot pad its way
 * past the end of itself.
 */
const SECTION_ALIGNMENT_TOLERANCE = 24;

// ---------------------------------------------------------------------------
// The bounds pass
// ---------------------------------------------------------------------------

/**
 * What the document declares about itself, read without decoding anything.
 *
 * `declaredChannelBytes` is the number that matters: it is the sum of the
 * lengths the layer records claim for their channel data, which is precisely
 * what ag-psd will allocate before it has drawn a single pixel.
 */
interface DeclaredSizes {
  layerCount: number;
  declaredChannelBytes: number;
}

type BoundsResult =
  | { kind: 'ok'; sizes: DeclaredSizes }
  | { kind: 'too-large'; reason: string }
  | { kind: 'unreadable'; reason: string };

/**
 * A cursor that cannot read past the end of its buffer and never allocates.
 *
 * Every read returns a refusal rather than a value when it would leave the
 * buffer, which is what makes the walk below total: there is no read in it
 * that can throw, and no read that can make it do work proportional to a
 * number the file chose.
 */
class Cursor {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  /** Move forward by `count` bytes, or refuse if that leaves the buffer. */
  skip(count: number): string | null {
    if (!Number.isSafeInteger(count) || count < 0) return 'a negative or non-integer length';
    if (count > this.remaining) return 'a length that runs past the end of the file';
    this.offset += count;
    return null;
  }

  u16(): number | string {
    if (this.remaining < 2) return 'a truncated 16-bit field';
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  i16(): number | string {
    if (this.remaining < 2) return 'a truncated 16-bit field';
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number | string {
    if (this.remaining < 4) return 'a truncated 32-bit field';
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Four bytes as a latin1 string, for signatures. */
  ascii4(): string | null {
    if (this.remaining < 4) return null;
    const value = this.buffer.toString('latin1', this.offset, this.offset + 4);
    this.offset += 4;
    return value;
  }
}

/** True when a read returned a refusal string rather than a value. */
function refused(value: number | string): value is string {
  return typeof value === 'string';
}

/**
 * Walk the file's declared structure and total up what it says it will need.
 *
 * Reads only the fields it must: the header for the signature and version (so
 * that a file which is not a PSD is refused here rather than inside ag-psd),
 * then past the colour-mode and image-resource blocks by their declared
 * lengths, then the layer records for their channel lengths. Nothing is
 * decoded, nothing is allocated, and no field from the file is ever used as a
 * loop bound or an allocation size.
 */
function readDeclaredSizes(buffer: Buffer, limits: LayerLimits): BoundsResult {
  const cursor = new Cursor(buffer);

  // --- File header ---------------------------------------------------------
  const signature = cursor.ascii4();
  if (signature !== '8BPS') return { kind: 'unreadable', reason: 'this is not a PSD file' };

  const version = cursor.u16();
  if (refused(version)) return { kind: 'unreadable', reason: version };
  if (version !== VERSION_PSD) {
    // PSB (version 2) widens several length fields to 64 bits. Rather than
    // carry a second dialect through this walk - and risk mis-walking it, which
    // would make the bounds below meaningless - it is refused by name. `.psb`
    // is not an extension we accept, so reaching here means the file was
    // renamed.
    return { kind: 'unreadable', reason: 'this is a PSB (large document) file, not a PSD' };
  }

  if (cursor.skip(6) !== null) return { kind: 'unreadable', reason: 'a truncated file header' };
  const channels = cursor.u16();
  const height = cursor.u32();
  const width = cursor.u32();
  if (refused(channels) || refused(height) || refused(width)) {
    return { kind: 'unreadable', reason: 'a truncated file header' };
  }
  // The two remaining header fields (bit depth, colour mode) do not affect the
  // walk: depth decides which typed array a layer decodes into, which is a
  // per-layer decision made after parsing, not a length.
  if (cursor.skip(4) !== null) return { kind: 'unreadable', reason: 'a truncated file header' };

  // --- Colour mode data, then image resources ------------------------------
  for (const block of ['colour mode data', 'image resources']) {
    const length = cursor.u32();
    if (refused(length)) return { kind: 'unreadable', reason: `a truncated ${block} length` };
    const problem = cursor.skip(length);
    if (problem !== null) return { kind: 'unreadable', reason: `${block}: ${problem}` };
  }

  // --- Layer and mask information -----------------------------------------
  const layerAndMaskLength = cursor.u32();
  if (refused(layerAndMaskLength)) {
    // A PSD with no layer section at all is legal and simply holds no layers.
    return { kind: 'ok', sizes: { layerCount: 0, declaredChannelBytes: 0 } };
  }
  if (layerAndMaskLength === 0) {
    return { kind: 'ok', sizes: { layerCount: 0, declaredChannelBytes: 0 } };
  }

  const layerInfoLength = cursor.u32();
  if (refused(layerInfoLength)) return { kind: 'unreadable', reason: 'a truncated layer section' };
  // Where this section ends. The section is the layer count, then every layer
  // record, then every channel's pixel data - and the pixel data occupies
  // exactly the sum of the channel lengths, because that is how a reader walks
  // it. So this boundary is a check on the whole walk, not just on the records:
  // see the closing assertion below.
  const sectionEnd = cursor.position + layerInfoLength;
  if (sectionEnd > buffer.length) {
    return { kind: 'unreadable', reason: 'the layer section runs past the end of the file' };
  }

  const layerCountField = cursor.i16();
  if (refused(layerCountField)) return { kind: 'unreadable', reason: 'a truncated layer count' };
  // Negative means the first alpha channel is transparency rather than an extra
  // channel; the magnitude is still the record count.
  const layerCount = Math.abs(layerCountField);

  if (layerCount > limits.maxLayers) {
    return {
      kind: 'too-large',
      reason: `the document declares ${layerCount} layers, over the ${limits.maxLayers} layer limit`,
    };
  }

  let declaredChannelBytes = 0;

  for (let index = 0; index < layerCount; index += 1) {
    if (cursor.position >= sectionEnd) {
      return { kind: 'unreadable', reason: 'a layer record runs past the end of the layer section' };
    }

    // Layer rectangle: four i32s, which decide nothing but the layer's size.
    if (cursor.skip(16) !== null) return { kind: 'unreadable', reason: 'a truncated layer record' };

    const channelCount = cursor.u16();
    if (refused(channelCount)) return { kind: 'unreadable', reason: 'a truncated layer record' };

    for (let channel = 0; channel < channelCount; channel += 1) {
      if (cursor.skip(2) !== null) return { kind: 'unreadable', reason: 'a truncated channel id' };
      const length = cursor.u32();
      if (refused(length)) return { kind: 'unreadable', reason: 'a truncated channel length' };

      // The ceiling ag-psd's own reader applies, applied here first so that a
      // single absurd channel is named as absurd rather than added up into a
      // total that is merely large.
      if (length > PER_CHANNEL_DECLARED_CEILING) {
        return {
          kind: 'too-large',
          reason: `a layer channel declares ${length} bytes, over the ${PER_CHANNEL_DECLARED_CEILING} byte ceiling`,
        };
      }

      declaredChannelBytes += length;
      if (declaredChannelBytes > limits.maxDecodeBytes) {
        return {
          kind: 'too-large',
          reason: `the document's layers declare ${declaredChannelBytes} bytes of pixel data, over the ${limits.maxDecodeBytes} byte limit`,
        };
      }
    }

    // Blend mode signature and key, then opacity, clipping, flags and filler.
    if (cursor.skip(12) !== null) return { kind: 'unreadable', reason: 'a truncated layer record' };
    const extraLength = cursor.u32();
    if (refused(extraLength)) return { kind: 'unreadable', reason: 'a truncated layer record' };
    // The rest of the record - mask data, blending ranges, the name, effects.
    // Skipped by its declared length, which is exactly where ag-psd's own
    // reader lands: it reads this block as a length-prefixed section and
    // advances to the section's end regardless of what it found inside.
    const problem = cursor.skip(extraLength);
    if (problem !== null) return { kind: 'unreadable', reason: `a layer record: ${problem}` };
  }

  // The whole walk, checked at once. Two separate questions, and only the first
  // is a security property.
  //
  // CAN THE DECLARED DATA BE IN THE FILE AT ALL? After the last record comes
  // every layer's channel pixel data, and it occupies exactly the bytes the
  // channel lengths declared. The file cannot hold more than its own length, so
  // a declared total that overruns the section is a lie by definition - and
  // that single comparison is the whole amplification defence. Inflating a
  // channel length to force a large allocation now buys nothing: the bound on
  // the total becomes the size of the layer section, which is bounded by the
  // size of the file, whatever the header claims.
  //
  // DID THE WALK UNDERSTAND THE FILE? The declared data should end ON the
  // section boundary, not merely inside it, so a walk that lands short has
  // misread something - and a misread walk could compute a small total while
  // ag-psd reads a large one from the same bytes. The tolerance is the
  // alignment a writer applies to the section, which is a handful of bytes;
  // it is deliberately loose, because this half is an integrity check and the
  // half above is what actually stops the attack.
  const unaccounted = sectionEnd - (cursor.position + declaredChannelBytes);
  if (unaccounted < 0) {
    return {
      kind: 'unreadable',
      reason:
        `the layers declare ${declaredChannelBytes} bytes of channel data, which does not fit the ` +
        `${layerInfoLength}-byte layer section they are in (${layerCount} layers, records end at ` +
        `${cursor.position}, section ends at ${sectionEnd})`,
    };
  }
  if (unaccounted > SECTION_ALIGNMENT_TOLERANCE) {
    return {
      kind: 'unreadable',
      reason:
        `the layer records and their declared channel data account for ${unaccounted} bytes less ` +
        `than the layer section holds (${layerCount} layers, ${declaredChannelBytes} declared ` +
        `channel bytes, section ends at ${sectionEnd})`,
    };
  }

  return { kind: 'ok', sizes: { layerCount, declaredChannelBytes } };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Make one layer or group name safe to use as a path segment inside the ZIP.
 *
 * Names come from the document, so they are attacker-controlled in exactly the
 * way the uploaded filename is - and they end up in the same kind of place: a
 * name some other machine will act on. `safeEntryName` in `zip.ts` is the
 * backstop that strips traversal, but it preserves interior slashes, so a layer
 * called `sub/layer` would quietly create a directory and the manifest would no
 * longer describe the archive it came with. Separators are removed here
 * instead, and every name in the manifest is the name in the archive.
 *
 * Windows is why the rules are not just "strip slashes": a name ending in a dot
 * or a space cannot be created there, the nine reserved characters cannot
 * appear at all, and CON/PRN/NUL and friends are device names rather than
 * files. None of that is a security problem, and all of it is a layer that
 * silently goes missing on the machine of whoever unzips it.
 */
export function safeLayerName(raw: string | undefined, fallback: string): string {
  // Lone surrogates survive ag-psd's per-UTF-16-unit name reader, and they are
  // the one case where the string in the manifest and the bytes in the archive
  // can disagree: JSON can carry an unpaired surrogate, UTF-8 cannot. Dropping
  // them here keeps the two identical.
  const paired = raw?.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') ?? '';

  const cleaned = paired
    // Control characters, including the newline that would break a listing.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Path separators and the characters Windows reserves.
    .replace(/[/\\:*?"<>|]/g, '_')
    // Leading dots would make a hidden file on Unix and a traversal-shaped
    // name to anything scanning for one.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

  // Counted in code points, so a name in a script outside the BMP is not cut
  // through the middle of a character.
  const points = Array.from(cleaned);
  const truncated = points.length > MAX_NAME_LENGTH ? points.slice(0, MAX_NAME_LENGTH).join('') : cleaned;

  return truncated === '' ? fallback : truncated;
}

/**
 * Reserve a name inside one directory of the archive.
 *
 * Case-insensitively, because the ZIP format is case-sensitive and the
 * machines people unzip on mostly are not: two layers called `Button` and
 * `button` are two perfectly good entries that collide into one file on
 * delivery, and the person who lost a layer never sees a reason why.
 */
function reserveName(taken: Map<string, number>, name: string): string {
  const key = name.toLowerCase();
  const seen = taken.get(key);

  if (seen === undefined) {
    taken.set(key, 1);
    return name;
  }

  let suffix = seen + 1;
  let candidate = `${name}_${suffix}`;
  while (taken.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${name}_${suffix}`;
  }
  taken.set(key, suffix);
  taken.set(candidate.toLowerCase(), 1);
  return candidate;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface FoundLayer {
  layer: Layer;
  /** Group names, outermost first, already sanitised. */
  groups: string[];
}

/**
 * Flatten the layer tree, depth first, recording each layer's group path.
 *
 * Each layer is taken in the order its group holds it, and groups in the order
 * the document holds them, so the archive lists layers exactly as the file
 * does. That order is the bottom of the stack first, because that is how
 * Photoshop writes them - which is why the manifest is the honest place to
 * learn the stack order from, and why nothing here reverses anything to look
 * more like the Layers panel.
 */
function walkLayers(layers: readonly Layer[], groups: string[], found: FoundLayer[]): void {
  for (const layer of layers) {
    if (layer.children && layer.children.length > 0) {
      // A group holds no pixels of its own; its name becomes a directory.
      const name = safeLayerName(layer.name, `Group ${groups.length + 1}`);
      walkLayers(layer.children, [...groups, name], found);
      continue;
    }
    found.push({ layer, groups });
  }
}

/**
 * A layer's pixels, or the reason there are none to write.
 *
 * Written as a decision about the pixels themselves rather than as a predicate
 * plus a separate read of `layer.imageData`, because the pixel data is a union
 * of four array types and only three of them are something this service can
 * write. Narrowing here means the encoder is handed a type it can actually
 * take, instead of the compiler having to be told that a check made elsewhere
 * has already happened.
 *
 * The two refusals are different in kind and the manifest says which: a layer
 * with no pixel data is a normal thing for a document to contain - an
 * adjustment layer, a text layer, a fill - while a layer whose pixels have a
 * depth PNG cannot carry is a limitation of this service. 32-bit float is
 * refused rather than squeezed into eight bits because there is no honest
 * answer to what a linear HDR pixel is in sRGB, and guessing would produce a
 * plausible-looking image that is simply not the one in the document. 16-bit
 * needs no such decision: PNG carries it natively, so `encodePng` writes it.
 */
type LayerPixels =
  | { kind: 'pixels'; width: number; height: number; data: Uint8ClampedArray | Uint8Array | Uint16Array }
  | { kind: 'skipped'; reason: string };

function pixelsOf(layer: Layer): LayerPixels {
  const image = layer.imageData;
  if (!image) return { kind: 'skipped', reason: 'no pixel data (adjustment, text or empty layer)' };
  if (image.width === 0 || image.height === 0) return { kind: 'skipped', reason: 'zero-sized layer' };
  if (image.data instanceof Float32Array) {
    return {
      kind: 'skipped',
      reason: '32-bit per channel (HDR) pixels, which this converter cannot write as a PNG',
    };
  }
  return { kind: 'pixels', width: image.width, height: image.height, data: image.data };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract every layer of a PSD as a PNG, plus a manifest describing them.
 *
 * Synchronous and in-process, like the table extractor, and for the same
 * reason: there is no child to kill and no deadline that could be enforced
 * part-way through. What bounds it instead is the pre-flight pass above, which
 * refuses an over-reaching document before a single pixel is decoded, so the
 * work that follows is proportional to a budget this service chose rather than
 * to a number the file chose.
 *
 * The one interruption available is between layers, which costs nothing and
 * means a client that has already gone does not pay for the rest of the
 * document.
 */
export function extractLayers(
  buffer: Buffer,
  limits: LayerLimits,
  signal?: AbortSignal,
): LayersExtraction {
  const bounds = readDeclaredSizes(buffer, limits);
  if (bounds.kind !== 'ok') return bounds;

  if (bounds.sizes.layerCount === 0) {
    return { kind: 'no-layers', reason: 'the document has no layer section' };
  }
  if (bounds.sizes.layerCount > limits.maxLayers) {
    return {
      kind: 'too-large',
      reason: `the document declares ${bounds.sizes.layerCount} layers, over the ${limits.maxLayers} layer limit`,
    };
  }

  let psd: Psd;
  try {
    // `useImageData` keeps the pixels as straight-alpha RGBA arrays instead of
    // routing them through a canvas; `skipCompositeImageData` avoids decoding
    // the flattened preview, which is a full-canvas image we never look at.
    // `totalMemoryLimit` is the parser's own budget and is kept as a second
    // line behind the pass above, not as the first one.
    psd = readPsd(buffer, {
      useImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      totalMemoryLimit: limits.maxDecodeBytes,
    });
  } catch (error) {
    // Every structural fault in the format arrives here: a bad signature, a
    // truncated section, an invalid blend mode, a colour mode ag-psd does not
    // know. They are one answer to the user - the file is not one we can read -
    // and the message from the parser is carried into the log rather than shown.
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  const found: FoundLayer[] = [];
  walkLayers(psd.children ?? [], [], found);

  const layers: ExtractedLayer[] = [];
  const records: LayerRecord[] = [];
  /** Names already used, per directory of the archive. */
  const takenByDirectory = new Map<string, Map<string, number>>();
  let outputBytes = 0;

  for (const { layer, groups } of found) {
    if (signal?.aborted) return { kind: 'cancelled' };

    const directory = groups.join('/');
    const name = safeLayerName(layer.name, `Layer ${records.length + 1}`);
    const rect = {
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      right: layer.right ?? 0,
      bottom: layer.bottom ?? 0,
    };
    const pixels = pixelsOf(layer);

    const record: LayerRecord = {
      name,
      group: directory === '' ? null : directory,
      file: null,
      width: pixels.kind === 'pixels' ? pixels.width : 0,
      height: pixels.kind === 'pixels' ? pixels.height : 0,
      ...rect,
      hidden: layer.hidden === true,
      // ag-psd scales this to 0..1 on the way in; the manifest reports the byte
      // the format actually stores, which is what a reader comparing against
      // Photoshop will be looking for.
      opacity: Math.round((layer.opacity ?? 1) * 0xff),
      bytes: 0,
      skippedReason: pixels.kind === 'skipped' ? pixels.reason : null,
    };

    if (pixels.kind === 'pixels') {
      let png: Buffer;
      try {
        png = encodePng({ width: pixels.width, height: pixels.height, data: pixels.data });
      } catch (error) {
        // A layer ag-psd handed us that the encoder will not take. Losing one
        // layer is far better than losing the document, and the manifest says
        // which and why.
        record.skippedReason = `could not be encoded: ${error instanceof Error ? error.message : String(error)}`;
        png = Buffer.alloc(0);
      }

      if (record.skippedReason === null) {
        // Both limits are checked before the bytes are kept, so a document that
        // blows the budget is refused rather than assembled and then refused.
        if (outputBytes + png.length > limits.maxOutputBytes) {
          return {
            kind: 'too-large',
            reason: `the layers produce more than the ${limits.maxOutputBytes} byte limit for image output`,
          };
        }

        let taken = takenByDirectory.get(directory);
        if (!taken) {
          taken = new Map();
          takenByDirectory.set(directory, taken);
        }
        const file = directory === ''
          ? `${reserveName(taken, name)}.png`
          : `${directory}/${reserveName(taken, name)}.png`;

        record.file = file;
        record.bytes = png.length;
        outputBytes += png.length;
        layers.push({ file, data: png });
      }
    }

    records.push(record);
  }

  const exported = records.filter((record) => record.file !== null).length;
  if (exported === 0) {
    return { kind: 'no-layers', reason: 'no layer in the document has pixels this service can write' };
  }

  // The same bound the walk enforced, checked again on the count that actually
  // came back. The two can disagree - a document can declare a small number of
  // records and still build a deeper tree than the record count suggests - and
  // the archive is assembled in memory, so the count that matters is this one.
  if (found.length > limits.maxLayers) {
    return {
      kind: 'too-large',
      reason: `the document holds ${found.length} layers, over the ${limits.maxLayers} layer limit`,
    };
  }

  return {
    kind: 'ok',
    layers,
    manifest: {
      canvas: { width: psd.width, height: psd.height },
      exported,
      skipped: records.length - exported,
      layers: records,
    },
  };
}

/** The manifest as it is written into the archive. */
export function manifestJson(manifest: LayersManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** The name the manifest always has, and never collides with a layer. */
export const MANIFEST_FILENAME = 'manifest.json';

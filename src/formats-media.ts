/**
 * The audio/video matrix for `POST /media/{target}` - deliberately its own
 * file, not an extension of `formats.ts`.
 *
 * `formats.ts`'s matrix is shaped around per-source-family FILTERS, because
 * that is what LibreOffice needs; `ffmpeg` needs none of that here - any
 * accepted audio extension can become any OTHER accepted audio extension,
 * and the same for video, with no per-pair table to get wrong. So this file
 * is two flat lists, not a matrix: `AUDIO_EXTENSIONS` and `VIDEO_EXTENSIONS`,
 * each converting only within its own kind (audio to audio, video to video -
 * extracting an audio track from a video file is a real, different feature
 * this endpoint does not offer).
 *
 * THE SET IS DELIBERATELY SMALLER THAN AUDIO/VIDEO SUPPORT COULD IN
 * PRINCIPLE COVER. Every extension below was verified by hand against the
 * real `ffmpeg` build this service runs - both reading and writing it, with
 * the exact zero-flags `-y -i in out` command `runFfmpegMedia` actually
 * issues (no per-pair codec/rate args exist to paper over a default that
 * fails) - before being added, the same standard every other format in this
 * service is held to. `.3gp` was tried and deliberately left out this pass:
 * ffmpeg's default muxer for it picks `libopencore_amrnb`, which hard-fails
 * on anything but an 8kHz source, and this engine has no per-pair resampling
 * to fix that with. The remaining CloudConvert-catalogue formats not yet
 * here (`ac3`/`amr`/`au`/`caf`/`oga`/`voc`/`weba` for audio;
 * `avi`/`flv`/`m4v`/`mpeg`/`mpg`/`ogv`/`rm`/`rmvb`/`swf`/`ts`/`vob`/`wmv` and
 * the rarer `3g2`/`cavs`/`dv`/`m2ts`/`mod`/`mts`/`mxf`/`wtv` for video) are
 * all, in principle, formats this same generic `ffmpeg` mechanism could
 * reach - adding one is a single line in the relevant list below, verified
 * against a real file the same way every entry here already was, not a new
 * engine or a new code path.
 */

export type MediaKind = 'audio' | 'video';

export type MediaExtension =
  | '.mp3'
  | '.wav'
  | '.flac'
  | '.ogg'
  | '.aac'
  | '.m4a'
  | '.wma'
  | '.opus'
  | '.aiff'
  | '.m4b'
  | '.mp4'
  | '.webm'
  | '.mkv'
  | '.avi'
  | '.mov'
  | '.flv';

export type MediaTargetId =
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'ogg'
  | 'aac'
  | 'm4a'
  | 'wma'
  | 'opus'
  | 'aiff'
  | 'm4b'
  | 'mp4'
  | 'webm'
  | 'mkv'
  | 'avi'
  | 'mov'
  | 'flv';

interface MediaFormat {
  extension: MediaExtension;
  id: MediaTargetId;
  kind: MediaKind;
  mediaType: string;
  label: string;
}

/**
 * One table, not two: every media format is both a source and a target (in
 * the same way most of `formats.ts`'s own extensions are), so there is no
 * separate `SOURCES`/`TARGETS` split to keep in sync here the way the main
 * matrix needs one - a source's family/filter concerns simply do not exist
 * for a flat transcode engine.
 */
const MEDIA_FORMATS: Readonly<Record<MediaTargetId, MediaFormat>> = {
  mp3: { extension: '.mp3', id: 'mp3', kind: 'audio', mediaType: 'audio/mpeg', label: 'MP3' },
  wav: { extension: '.wav', id: 'wav', kind: 'audio', mediaType: 'audio/wav', label: 'WAV' },
  flac: { extension: '.flac', id: 'flac', kind: 'audio', mediaType: 'audio/flac', label: 'FLAC' },
  ogg: { extension: '.ogg', id: 'ogg', kind: 'audio', mediaType: 'audio/ogg', label: 'OGG' },
  aac: { extension: '.aac', id: 'aac', kind: 'audio', mediaType: 'audio/aac', label: 'AAC' },
  m4a: { extension: '.m4a', id: 'm4a', kind: 'audio', mediaType: 'audio/mp4', label: 'M4A' },
  wma: { extension: '.wma', id: 'wma', kind: 'audio', mediaType: 'audio/x-ms-wma', label: 'WMA' },
  opus: { extension: '.opus', id: 'opus', kind: 'audio', mediaType: 'audio/opus', label: 'OPUS' },
  aiff: { extension: '.aiff', id: 'aiff', kind: 'audio', mediaType: 'audio/aiff', label: 'AIFF' },
  m4b: { extension: '.m4b', id: 'm4b', kind: 'audio', mediaType: 'audio/mp4', label: 'M4B' },
  mp4: { extension: '.mp4', id: 'mp4', kind: 'video', mediaType: 'video/mp4', label: 'MP4' },
  webm: { extension: '.webm', id: 'webm', kind: 'video', mediaType: 'video/webm', label: 'WEBM' },
  mkv: {
    extension: '.mkv',
    id: 'mkv',
    kind: 'video',
    mediaType: 'video/x-matroska',
    label: 'MKV',
  },
  avi: { extension: '.avi', id: 'avi', kind: 'video', mediaType: 'video/x-msvideo', label: 'AVI' },
  mov: { extension: '.mov', id: 'mov', kind: 'video', mediaType: 'video/quicktime', label: 'MOV' },
  flv: {
    extension: '.flv',
    id: 'flv',
    kind: 'video',
    mediaType: 'video/x-flv',
    label: 'FLV',
  },
};

export const MEDIA_EXTENSIONS = Object.values(MEDIA_FORMATS).map((f) => f.extension) as MediaExtension[];
export const MEDIA_TARGET_IDS = Object.keys(MEDIA_FORMATS) as MediaTargetId[];

export function isMediaExtension(ext: string): ext is MediaExtension {
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
}

export function isMediaTargetId(id: string): id is MediaTargetId {
  return Object.prototype.hasOwnProperty.call(MEDIA_FORMATS, id);
}

function kindOfExtension(ext: MediaExtension): MediaKind {
  const found = Object.values(MEDIA_FORMATS).find((f) => f.extension === ext);
  // Every MediaExtension has exactly one entry above - validated at import
  // time by `validateMediaMatrix`.
  return found!.kind;
}

export function mediaFormat(id: MediaTargetId): MediaFormat {
  return MEDIA_FORMATS[id];
}

/**
 * Is this extension/target pair legal - same kind, and not a source
 * converting to its own format?
 */
export function resolveMediaConversion(
  extension: MediaExtension,
  targetId: MediaTargetId,
): MediaFormat | null {
  const target = MEDIA_FORMATS[targetId];
  if (target.extension === extension) return null; // no self-conversion, same rule as formats.ts
  if (kindOfExtension(extension) !== target.kind) return null; // audio stays audio, video stays video
  return target;
}

/** Every target a given source extension can become, as ids - for error messages. */
export function mediaTargetsFor(extension: MediaExtension): MediaTargetId[] {
  const kind = kindOfExtension(extension);
  return MEDIA_TARGET_IDS.filter((id) => MEDIA_FORMATS[id].kind === kind && MEDIA_FORMATS[id].extension !== extension);
}

export function describeMediaSources(): string {
  return MEDIA_EXTENSIONS.join(', ');
}

export function describeMediaTargets(ids: readonly MediaTargetId[]): string {
  return ids.map((id) => MEDIA_FORMATS[id].label).join(', ');
}

function validateMediaMatrix(): void {
  const problems: string[] = [];
  for (const [id, format] of Object.entries(MEDIA_FORMATS)) {
    if (id !== format.id) problems.push(`MEDIA_FORMATS["${id}"].id is "${format.id}"`);
    if (!format.extension.startsWith('.')) {
      problems.push(`media format "${id}" has a bare extension "${format.extension}"`);
    }
    if (format.extension.slice(1) !== id) {
      problems.push(`media format "${id}" extension "${format.extension}" does not match its own id`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Media matrix is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

validateMediaMatrix();

/**
 * Naming the file we send back.
 *
 * The person uploaded `Quarterly report.docx` and asked for a PDF. Handing them
 * `converted.pdf` throws away the only thing that told them which document this
 * is, which matters as soon as they convert more than one thing - and it is the
 * kind of detail that makes a service feel unfinished.
 *
 * So the download keeps the upload's name and takes the target's extension:
 * `Quarterly report.docx` -> `Quarterly report.pdf`.
 *
 * Everything here is written on the assumption that the name comes from a
 * hostile client, because it does. `originalname` is whatever the multipart
 * headers said, and it can contain a path, a newline, a quote or four thousand
 * letters. Two consequences:
 *
 *   - A filename ending up in a response header is a HEADER INJECTION vector.
 *     A name containing CRLF could otherwise terminate the header early and let
 *     the client write headers of its own choosing. Control characters are
 *     stripped rather than escaped, because there is no legitimate filename
 *     containing one.
 *   - The name is a SUGGESTION to the recipient's machine, which is why the
 *     directory part is dropped rather than sanitised: `../../.ssh/authorized_keys`
 *     must not survive as a path anyone might act on.
 */
import { MAX_DOWNLOAD_NAME_LENGTH } from '../config.ts';

/**
 * Recover the filename the client actually sent.
 *
 * multer hands us `originalname` with every byte of the UTF-8 the client sent
 * read as a SEPARATE LATIN-1 CHARACTER. This is busboy's doing and it is not
 * configurable. `KÖKLƏR` therefore arrives as `KÃKLÆR`: `Ö` is `C3 96` in
 * UTF-8, and reading those two bytes as latin1 gives `Ã` followed by a C1
 * control character that is invisible in a terminal and turns into noise
 * wherever it is displayed.
 *
 * Undoing it is a re-encode: take the string's code points as the bytes they
 * were, and decode them as UTF-8. Two cases have to be left ALONE, and both
 * are checked before touching anything:
 *
 *   - a name that is already correct, including any non-ASCII character above
 *     U+00FF. Latin-1 cannot represent those, so seeing one proves the bytes
 *     were decoded properly already (`filename*` in the multipart headers is
 *     handled correctly by busboy) and re-reading it would destroy it.
 *   - a name that was GENUINELY Latin-1 - `café` sent as single bytes. Those
 *     bytes are not valid UTF-8, so the decode fails and the original stands.
 *     Guessing wrong here would corrupt a name that was never broken.
 */
export function decodeUploadName(raw: string): string {
  // Pure ASCII is already right, and is the common case.
  if (!/[\u0080-ÿ]/.test(raw)) return raw;
  if (/[^\u0000-ÿ]/.test(raw)) return raw;

  const bytes = Buffer.from(raw, 'latin1');
  const decoded = bytes.toString('utf8');

  // Node's decoder emits U+FFFD for a byte sequence that is not valid UTF-8,
  // so its presence means this was never UTF-8 to begin with.
  if (decoded.includes('�')) return raw;
  return decoded;
}

/**
 * Best-effort ASCII rendering of a name, for the `filename` fallback.
 *
 * Decomposing first means an accented letter keeps its base character instead
 * of being replaced wholesale - `Résumé` becomes `Resume` rather than `R_sum_`
 * - and only characters with no ASCII equivalent at all are marked with an
 * underscore. This form is only read by clients too old to understand
 * `filename*`; everything current uses the accurate one.
 */
function asciiRender(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^ -~]/g, '_');
}

/**
 * The basename to build a download name from, or '' if nothing usable is left.
 *
 * Deliberately conservative: anything questionable is removed rather than
 * repaired, and the caller falls back to a generic name. A slightly worse
 * filename is a much smaller problem than a header injection.
 */
function baseNameOf(originalName: string): string {
  // The last path segment. Browsers strip directories themselves, but this
  // value is also used to build an archive name and must never look like a path.
  const lastSegment = originalName.split(/[/\\]/).pop() ?? '';

  // Drop the final extension, which the target replaces. Any earlier dots
  // survive, so `archive.tar.gz` becomes `archive.tar.pdf` rather than losing
  // the part that distinguishes it.
  const withoutExtension = lastSegment.replace(/\.[^.]*$/, '');

  const cleaned = withoutExtension
    // Control characters, and the two characters that would end the quoted
    // `filename="..."` value early.
    //
    // The range covers C1 as well as C0. C1 is the half that is easy to miss
    // and the half that shows up in practice: it is exactly what a mangled
    // multi-byte character leaves behind, so a name that survived the decode
    // above can still carry one.
    .replace(/[\u0000-\u001f\u007f-\u009f"\\]/g, '')
    .trim()
    // A leading dot would make the result a hidden file on the receiving side.
    .replace(/^\.+/, '');

  // Counted in code points, not UTF-16 units, so a name full of emoji is not
  // truncated through the middle of a character.
  return Array.from(cleaned).slice(0, MAX_DOWNLOAD_NAME_LENGTH).join('');
}

/**
 * The name to offer for the converted file.
 *
 * `originalName` is the client's filename from the upload, `extension` the
 * target's (including the dot). Falls back to `converted.<ext>` when the
 * original has nothing usable in it - an upload named `.docx`, say.
 */
export function downloadNameFor(originalName: string, extension: string): string {
  const base = baseNameOf(decodeUploadName(originalName));
  return base === '' ? `converted${extension}` : `${base}${extension}`;
}

/**
 * A `Content-Disposition` value carrying the filename safely.
 *
 * RFC 6266 in both directions: the quoted `filename` is what older clients
 * read and must therefore be plain ASCII, while `filename*` carries the real
 * name percent-encoded as UTF-8 for everything modern. A name like
 * `Résumé.docx` therefore arrives as `Résumé.pdf` in a current browser and as
 * `R_sum_.pdf` in an ancient one, rather than as mojibake in both.
 */
export function contentDispositionFor(filename: string): string {
  const ascii = asciiRender(filename).replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

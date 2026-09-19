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
    // Control characters, including CR and LF, and the two characters that
    // would end the quoted `filename="..."` value early.
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
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
  const base = baseNameOf(originalName);
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
  const ascii = filename.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

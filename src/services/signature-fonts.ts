/**
 * The one embedded handwriting-style font `/pdf/sign` uses for a typed
 * "signature"/"initials" element with `fontStyle: "cursive"`.
 *
 * pdf-lib's `StandardFonts` are the 14 built-in PDF base fonts (Helvetica,
 * Times, Courier and their bold/italic variants) - none of them is remotely
 * script-like, so there is no way to produce something that reads as a
 * signature without embedding a real font file via `PDFDocument.
 * registerFontkit()` + `embedFont(bytes)`.
 *
 * "Dancing Script" was chosen over the also-reasonable "Caveat": both are
 * OFL-licensed Google Fonts families distributed from Google's own
 * `google/fonts` GitHub repository, freely embeddable/redistributable, and
 * both were verified (via a throwaway `pdf-lib` embed) to actually load
 * before being wired into `signPdf`. `assets/fonts/OFL-DancingScript.txt` is
 * that font's own license file, copied verbatim from the same repository -
 * required by the OFL, not merely polite.
 *
 * `"cursive2"` is deliberately NOT a second downloaded font: fetching,
 * licensing and vendoring a whole extra TTF for one more style is the kind
 * of scope creep the task description explicitly calls out as optional, and
 * `signPdf` instead maps `"cursive2"` to pdf-lib's own
 * `HelveticaBoldOblique` - a bold-italic "print-style signature" look that
 * is visually distinct from the Dancing Script cursive without adding a
 * second binary asset (and a second license file) to the repo for it.
 *
 * The bytes are read once per process and cached: `embedFont` still has to
 * be called once per `PDFDocument` (a pdf-lib font object is tied to the
 * document it was embedded into), but re-reading the same ~130KB file off
 * disk for every `/pdf/sign` request would be pure waste.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

// Same resolution trick as `PDF_ENGINE_SCRIPT` in `config.ts`: this file
// lives at `src/services/signature-fonts.ts` and compiles to
// `dist/services/signature-fonts.js`, both two directories below the repo
// root (`/app` at runtime), so `..`, `..` reaches `assets/fonts` from either
// one. The Dockerfile's runtime stage copies `assets` alongside `scripts`
// for exactly this reason - see the `COPY assets ./assets` line there.
const DANCING_SCRIPT_PATH = join(import.meta.dirname, '..', '..', 'assets', 'fonts', 'DancingScript.ttf');

let cachedBytes: Promise<Buffer> | undefined;

/** The vendored Dancing Script TTF's bytes, read once and reused. */
export function dancingScriptFontBytes(): Promise<Buffer> {
  cachedBytes ??= fsp.readFile(DANCING_SCRIPT_PATH);
  return cachedBytes;
}

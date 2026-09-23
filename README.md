# Universal file converter

A Node.js service that converts documents, spreadsheets, presentations and
images between formats using LibreOffice headless. It began as the backend for
an Android app that uploads a Word document and receives a PDF, and that
contract still holds exactly. A browser-based converter web app now talks to
the same API — see [`CORS_ORIGIN`](#configuration) — but nothing about the
API changed to accommodate it: it is a second consumer of the one contract
below, not a second contract.

No database, no state. The interesting parts are the things that are easy to get
subtly wrong: **font metrics** (which decide pagination), **per-process
LibreOffice profiles** (which decide whether concurrent conversions work at
all), **which export filter belongs to which document family**, and the **error
contract** with a client that is already shipped and cannot be changed.

---

## Contents

- [Quick start](#quick-start)
- [Command-line tool](#command-line-tool)
- [Conversion matrix](#conversion-matrix)
- [API](#api)
  - [POST /convert/{target}](#post-converttarget)
  - [POST /media/{target} (asynchronous audio/video)](#post-mediatarget--asynchronous-audiovideo-conversion)
  - [POST /pdf/{merge,split,remove-pages,extract-pages,organize,scan-to-pdf}](#post-pdfmergesplitremove-pagesextract-pagesorganizescan-to-pdf)
  - [POST /pdf/{rotate,watermark,protect,unlock}](#post-pdfrotatewatermarkprotectunlock)
  - [POST /pdf/{crop,page-numbers,repair}](#post-pdfcroppage-numbersrepair)
  - [GET /formats](#get-formats)
  - [GET /health](#get-health)
  - [Error reference](#error-reference)
  - [Wire-compatibility constraints](#wire-compatibility-constraints)
- [API documentation (OpenAPI)](#api-documentation-openapi)
- [Fonts, and why they are not optional](#fonts-and-why-they-are-not-optional)
- [How conversion works](#how-conversion-works)
- [Image targets, and why they need poppler](#image-targets-and-why-they-need-poppler)
- [Extracting tables](#extracting-tables)
- [Extracting PSD layers](#extracting-psd-layers)
- [Concurrency model](#concurrency-model)
- [Cleanup and temp files](#cleanup-and-temp-files)
- [Operational limits](#operational-limits)
- [Configuration](#configuration)
- [Security posture](#security-posture)
- [Deployment](#deployment)
- [Development](#development)
- [Notes from building this](#notes-from-building-this)

---

## Conversion matrix

What the service accepts, and what each input can become. This table is
implemented in [`src/formats.ts`](src/formats.ts) and served at
[`GET /formats`](#get-formats); the two are kept in step by
[`test/unit.test.ts`](test/unit.test.ts).

| From | To |
|---|---|
| `.docx` `.docm` | PDF, ODT, TXT, HTML, RTF, EPUB, XLSX (tables) |
| `.doc` `.dot` `.dotx` | PDF, DOCX, ODT, TXT, HTML, RTF, EPUB |
| `.xlsx` | PDF, ODS, CSV, HTML |
| `.xls` `.xlsm` | PDF, XLSX, ODS, CSV, HTML |
| `.pptx` | PDF, ODP, PNG/JPG (one image per slide) |
| `.ppt` `.pptm` `.pps` `.ppsx` `.pot` `.potx` | PDF, PPTX, ODP, PNG/JPG (one image per slide) |
| `.odt` | PDF, DOCX, TXT, HTML, RTF, EPUB |
| `.odg` | PDF |
| `.ods` | PDF, XLSX, HTML, CSV |
| `.odp` | PDF, PPTX, PNG/JPG (one image per slide) |
| `.csv` | XLSX, ODS, PDF, HTML, plus TSV/JSON/YAML/JSONL (see below) |
| `.txt` | PDF, DOCX, ODT, HTML, RTF, EPUB |
| `.html` `.htm` | PDF, DOCX, ODT, TXT, RTF, EPUB |
| `.rtf` | DOCX, PDF, ODT, TXT, HTML, EPUB |
| `.png` `.jpg` `.jpeg` | PDF, SVG, EMF, WMF, EPS, HEIC, HEIF, plus BMP/GIF/TIFF/WEBP/AVIF/ICO/JXL/JP2/QOI/TGA/PCX/APNG/PNG (image)/JPG (image) (see below) |
| `.psd` | PNG (one image per layer) |
| `.pdf` | PDF/A, PNG/JPG (one image per page), SVG, EMF, WMF, EPS, DOCX/PPTX/XLSX/Markdown (see below) |
| `.svg` | PDF, EMF, WMF, EPS, HEIC, HEIF, plus BMP/GIF/TIFF/WEBP/AVIF/ICO/JXL/JP2/QOI/TGA/PCX/APNG/PNG (image)/JPG (image) (LibreOffice opens an SVG as a Draw document for PDF/SVG/EMF/WMF/EPS; `ffmpeg`'s own `librsvg` decoder reads it directly for the rest) |
| `.emf` `.wmf` `.eps` | PDF, SVG, plus each other (minus whichever is its own format) - LibreOffice Draw only; no `ffmpeg` decoder for any of the three in this build, so no raster/transcode targets |
| `.heic` `.heif` | HEIC/HEIF (minus whichever is its own format), plus BMP/GIF/TIFF/WEBP/AVIF/ICO/JXL/JP2/QOI/TGA/PCX/APNG/PNG (image)/JPG (image) (`libheif`'s `heif-convert`/`heif-enc` - the one pair `ffmpeg` cannot read or write at all in this build) |
| `.rst` `.tex` `.textile` `.org` `.opml` `.muse` `.ipynb` | DOCX, HTML, ODT, RTF, TXT, Markdown |
| `.md` | DOCX, HTML, ODT, RTF, TXT |
| `.zip` | TAR, TAR.GZ, TAR.BZ2, TAR.ZST, 7Z, CBZ |
| `.tar` `.tgz` `.tbz2` `.txz` `.gz` `.bz2` `.xz` `.zst` `.iso` | ZIP, TAR, TAR.GZ, TAR.BZ2, TAR.ZST, 7Z, CBZ (minus whichever is its own format; `.zst` alone needs the standalone `zstd` CLI to undo its outer layer, since `7z` has no Zstandard codec) |
| `.7z` | ZIP, TAR, TAR.GZ, TAR.BZ2, TAR.ZST, CBZ |
| `.cbz` | ZIP, TAR, TAR.GZ, TAR.BZ2, TAR.ZST, 7Z (a CBZ is a plain ZIP of page images under a comic-reader extension, so it rides the same archive engine) |
| `.bmp` `.gif` `.tiff` `.webp` `.avif` `.ico` `.jxl` `.jp2` `.qoi` `.tga` `.pcx` `.apng` | BMP/GIF/TIFF/WEBP/AVIF/ICO/JXL/JP2/QOI/TGA/PCX/APNG (minus whichever is its own format), plus HEIC/HEIF |
| `.srt` `.vtt` `.ass` `.ssa` | SRT/VTT/ASS/SSA (minus whichever is its own format) |
| `.tsv` `.json` `.yaml` `.yml` `.jsonl` `.xml` `.toml` `.ini` `.sqlite` `.parquet` `.orc` `.feather` | CSV, plus TSV/JSON/YAML/JSONL/XML/TOML/INI/SQLite/Parquet/ORC/Feather (minus whichever is its own format; `.sqlite`/`.parquet`/`.orc`/`.feather` are bytes, not text - see below) |
| `.obj` `.stl` `.ply` `.glb` `.3mf` | OBJ, STL, PLY, GLB, 3MF (minus whichever is its own format) - `assimp`, a ninth engine |
| `.off` | OBJ, STL, PLY, GLB, 3MF - read-only: `assimp` has no OFF writer at all (see below) |
| `.epub` `.mobi` `.azw3` `.fb2` `.lrf` `.pdb` | EPUB, MOBI, AZW3, FB2, LRF, PDB, SNB, KEPUB (minus whichever is its own format) - Calibre's `ebook-convert`, a tenth engine |
| `.ttf` `.otf` `.woff` `.woff2` | TTF, OTF, WOFF, WOFF2 (minus whichever is its own format) - `fontTools`, an eleventh engine |
| `.parquet` `.orc` `.feather` | CSV, plus TSV/JSON/YAML/JSONL/XML/TOML/INI/SQLite/Parquet/ORC/Feather (minus whichever is its own format) - `pyarrow`, a twelfth engine, bridged into the data engine's common model (see below) |
| `.eml` | TXT, HTML (a short From/To/Subject/Date header block plus the body) - `mailparser`, pure JS, no subprocess |

`.ppt`/`.pps`/`.pot` and their `x` siblings, `.dot`/`.dotx`, and `.xls`/
`.xlsm` are legacy or variant extensions LibreOffice already opens through
the same Impress/Writer/Calc filters `.pptx`/`.docx`/`.xlsx` use — adding them
was a matrix entry, not a new engine. `.dotx` deliberately does **not** get
`tables`: nothing has verified the extractor against a real template's
`word/document.xml`, so it stays off rather than being added speculatively.
`.odg` (an OpenDocument drawing) gets only `pdf` — the raster targets are
reserved for sources with actual pages (a presentation, or a PDF), which a
single-canvas drawing is not. Microsoft Publisher (`.pub`) was evaluated and
deliberately left out: LibreOffice's Publisher import is historically weak
and there was no way to construct or verify a real `.pub` fixture, so it
stays out until someone can actually test it.

Every filter name in that table was verified by running the real conversion
against LibreOffice 24.2. That is not ceremony: **a wrong filter name is not an
error**. LibreOffice silently falls back to the default export filter for the
target, producing a file of the right type with the wrong content.

The reverse-direction rows (`.odt` → `.docx`, `.ods` → `.xlsx`, `.odp` →
`.pptx`) are deliberately short — they are what the table promises, and a target
we advertise is a target we have to keep working. Extending one is a single line
in `src/formats.ts`, and `validateMatrix()` runs at import time to make sure the
tables cannot contradict each other.

The image targets are offered from **both** `.pptx` and `.odp`. They are the
same kind of document and the pipeline behind them is identical, so the
asymmetry would be an artefact of the table rather than of anything the
conversion engine cares about.

### Markup sources: pandoc, a non-LibreOffice engine

`.md`, `.rst`, `.tex`, `.textile`, `.org`, `.opml`, `.muse` and `.ipynb` are
not documents LibreOffice opens, so they never reach `soffice`. They are read
by `pandoc` instead (see [`pandoc.engine.ts`](src/engines/pandoc.engine.ts)),
the same way a PDF's `docx`/`pptx`/`xlsx`/`markdown` route through the
"second, independent conversion engine" below (`pdf_engine.py`) rather than a
LibreOffice filter — this is a third such engine, alongside it.
`formats.ts` names this explicitly: `TargetFormat.engineFrom` is keyed by
engine (`pdf` or `pandoc`), and `ResolvedConversion.engine` carries the
choice forward to the converter.

`.md` does **not** get the `markdown` target — a Markdown file "converting" to
Markdown is not a conversion this service should offer. Every other markup
source does: pandoc's own `gfm` writer, not its `markdown` writer, because a
plain "give me a `.md` file" request means GitHub-Flavored Markdown, not
pandoc's own extension syntax (`:---:` alignment markers, footnote syntax)
that most consumers do not expect.

AsciiDoc (`.adoc`) is deliberately **not** in the matrix. Debian's `pandoc`
package ships without the `asciidoc` reader at all - confirmed by running
`pandoc --list-input-formats` (it is absent) and `pandoc -f asciidoc`
(`Unknown input format asciidoc`) against the exact build this service was
verified with. Advertising it would mean every request 500s.

Pandoc's PDF output (a LaTeX engine or `wkhtmltopdf`/weasyprint) is
deliberately **not** wired up either. It is a large, separate dependency with
its own failure modes, and anyone who needs a PDF from Markdown already has a
faithful path: `.md` → `docx` (through this engine) → `pdf` (through the
already-verified, already-running LibreOffice `docx`→`pdf` filter).

### Archive sources: `7z`, and why unpacking gets extra rules

`.zip`, `.tar`, `.tgz`, `.tbz2`, `.txz`, `.gz`, `.bz2`, `.xz`, `.7z` and
`.iso` convert to `zip`/`tar`/`tar.gz`/`tar.bz2`/`7z` through
[`archive.engine.ts`](src/engines/archive.engine.ts), which runs `7z`
(p7zip) as a subprocess - a fourth non-LibreOffice engine.

This is the one place in the service that genuinely **unpacks** untrusted
bytes to disk. [`unzip.ts`](src/lib/unzip.ts)'s own header comment states the
house rule everywhere else in the codebase follows: *"we look up ONE entry by
name and return its bytes. We never list the archive, never write anything to
disk, and never build a path out of a name that came from inside the file.
Zip-slip is a hazard of unpacking, and we do not unpack."* Converting an
archive to another archive format breaks that rule on purpose - there is no
way to repack a `.zip` as a `.tar` without putting its files somewhere first
- so the mitigations that rule made unnecessary everywhere else exist here
instead:

1. **List before extracting.** `7z l -slt` reports every entry's declared
   path, size and attributes without writing a single byte to disk. The
   whole conversion is refused - before any extraction runs - if the entry
   count is over `MAX_ARCHIVE_ENTRIES` (default 5,000), if the total declared
   uncompressed size is over `MAX_ARCHIVE_UNCOMPRESSED_BYTES` (default
   512MB), if any entry's path escapes the extraction directory, or if any
   entry is a symlink.
2. **Every symlink is refused outright**, not merely "not followed" - a
   symlink inside an archive being converted serves no purpose this feature
   needs. This is a second, independent check ahead of `7z`'s own: this
   build of `7z` already refuses to write a symlink whose target would
   escape the extraction directory (`ERROR: Dangerous link path was ignored`,
   a non-zero exit), verified by hand against a real crafted archive.
3. **Path traversal is checked ourselves too**, ahead of `7z`'s own defence
   (also verified by hand: on Linux, `7z x` writes a `../../escape` entry
   name *inside* the extraction directory rather than resolving it against
   one - it does not treat `..` in an archived path as an instruction to
   escape). A path is rejected if any segment is `.` or `..`, or if it is
   absolute.
4. **Every entry lands in a dedicated, per-request subdirectory** of the
   workspace `createWorkspace()` already gives every request - the same
   isolation and `0700` permissions every other engine gets.
5. **Only `7z`'s exit code is trusted.** A non-zero exit - whether it is one
   skipped entry's warning or a hard failure - fails the whole conversion,
   rather than trying to tell "a warning that's fine" from "a warning that
   matters" apart from stderr text, which the CLI does not promise to make a
   reliable distinction on.

All five are exercised against real, hand-crafted malicious archives in
[`test/integration.test.ts`](test/integration.test.ts)'s archive-engine
section - a zip-slip attempt, a symlink escaping the extraction directory, an
entry-count bomb, a declared-size decompression bomb, and a password-protected
archive (refused as `E_ENCRYPTED`, not a generic failure) - not just asserted
in the abstract.

**`.tar.gz`/`.tar.bz2`/`.tar.xz` are not extensions of their own.** Node's
`extname()` (what the upload filter uses) only ever returns the *last*
extension, so a `report.tar.gz` upload is already accepted as `.gz` - which
reads correctly, because the extraction is content-based, not name-based: it
detects a first pass that produced a single `.tar` file and recurses into it
once, whatever the upload was actually called. `.tgz`/`.tbz2`/`.txz` are
listed as their own source extensions because those *are* single, whole
extensions `extname()` returns intact.

**RAR (`.rar`) is accepted as a source only.** `7z` reads `Rar` and `Rar5`
(`7z i` lists both), so a `.rar` converts to `zip`, `tar`, `tar.gz`, `tar.bz2`,
`tar.zst`, `7z` or `cbz`. It is never a target: the format's writer is
proprietary and `7z`/p7zip can only ever read it. There is still no legal way
to author a real `.rar` fixture, so the read path is not covered by an
end-to-end test the way every other archive source is.

**`zip` is written by this codebase's own [`zip.ts`](src/lib/zip.ts)**, not
another `7z` subprocess call - the project's standing rule is that a format
describable in a few hundred lines does not justify a dependency, and
`zip.ts` already is that description, trusted and in use elsewhere (the
raster/layers targets' multi-file responses). `7z` writes everything
`zip.ts` does not: `tar`, `7z`, and (in two steps, since one `7z a` call
cannot write a compound format directly - verified by hand) `tar.gz`/
`tar.bz2`.

### Image sources: `ffmpeg`, and the PNG/JPG target that is deliberately missing

`.bmp`, `.gif`, `.tiff`, `.webp`, `.avif` and `.ico` convert to
`bmp`/`gif`/`tiff`/`webp`/`avif`/`ico`/`png-image`/`jpg-image` through
[`ffmpeg.engine.ts`](src/engines/ffmpeg.engine.ts), a fifth non-LibreOffice
engine. `.png`, `.jpg` and `.jpeg` - already sources, but previously reaching
only `pdf` - now reach all eight of these too (minus their own format:
`.png` does not offer `png-image`, `.jpg` does not offer `jpg-image` - see
below).

**`png-image`/`jpg-image` are NOT `png`/`jpg`.** Those two existing ids
already mean something fixed and load-bearing: "one image PER PAGE of a
presentation or PDF, always answered as a ZIP" (`mode: 'raster'`,
`multiple: true`). `multiple` is a property of the TARGET ID, fixed across
every source that reaches it, not something one pair can override - so a
plain image converting to a single PNG file (one file in, one file out,
never an archive) cannot reuse `png`/`jpg` without either breaking that
promise for existing raster consumers or wrapping a single transcoded image
in a one-entry ZIP, which is a worse response for the ordinary case. This
codebase's own precedent for exactly this shape of collision is `tables` vs
`xlsx` and `layers` vs `png`: a differently-shaped operation gets its own
name rather than a second meaning bolted onto an existing one -
`png-image`/`jpg-image` follow it the same way. (An earlier pass of this
feature left the two out entirely as a need nobody had asked for yet; a
plain "convert my PNG to JPG" request is common enough that leaving it out
was the actual gap, not the conservative choice.)

**`-frames:v 1 -update 1` is mandatory on every `ffmpeg` call, not
cosmetic.** Without it, a GIF or WEBP source - which ffmpeg decodes as a
one-frame *video*, not a still image, even when it has only one visible
frame - trips the `image2` muxer into `Cannot write more than one file with
the same name` and the whole conversion fails. `-frames:v 1` caps the output
at one frame regardless of how many the source has (so an animated GIF/WEBP
becomes its first frame, rather than a failed conversion), and `-update 1`
tells the muxer this is a single still image rather than a sequence at all.
Verified by hand against a real GIF before this was added - see
`ffmpeg.engine.ts`'s own header comment.

**A non-zero `ffmpeg` exit is checked explicitly, unlike `soffice`'s.**
`soffice --convert-to` always exits 0 regardless of success, so every
`soffice`-backed pipeline here determines success from whether a file was
actually produced - but `ffmpeg`'s exit code is genuinely meaningful, and a
failed run can still leave a small partial file behind at the output path
(verified by hand: an image over ICO's size limit, below, leaves a 4-byte
stub there even though the encode failed). Reusing the `soffice`-shaped
"ignore the exit code, check for a file" logic here silently turned a real
`ffmpeg` failure into a corrupt 200 response during this feature's own
testing - caught by the ICO-oversize test below, not by inspection - which
is exactly why `pandoc`'s pipeline was audited and given the same explicit
exit-code check at the same time: pandoc's exit code is just as meaningful,
and the same class of bug was silently possible there too.

**ICO cannot hold an image over 256x256** - a real limitation of the format,
verified by hand (`ffmpeg` refuses with `Unsupported dimensions ...
(dimensions cannot exceed 256x256)` and a non-zero exit for anything
larger). This service does not silently downscale an image to make a
request succeed - it does not do that for any other target either - so a
large image asking for `ico` fails honestly with `E_CONVERT_FAILED` rather
than being auto-resized.

A request for a target that exists but is not reachable from your source is a
`415` whose message lists what that source *can* become. A target that does not
exist at all is a `404`.

### `.svg`: no new engine, two existing ones

`.svg` needed no new dependency. LibreOffice opens an SVG as a Draw document
directly, the same way `.png`/`.jpg` already do - verified by hand
(`draw_svg_Import`/`draw_svg_Export`, the same filter id `soffice`'s own log
line names for the export direction, against both a real PDF and a real PNG)
- which is what lets `.svg` reach `pdf`/`svg` the ordinary `direct`-mode way.
Separately, this build's `ffmpeg` also decodes SVG itself (an
`--enable-librsvg` build - verified by hand), which is what lets `.svg`
reach the ordinary `bmp`/`gif`/`tiff`/`webp`/`avif`/`ico`/`png-image`/
`jpg-image` targets the same flat way every other image source does. There
is no SVG *encoder* in this `ffmpeg` build or a plausible one to add - a
raster image becoming genuine vector art is not a real conversion - so `svg`
as a target is reached only through the LibreOffice route, from sources
whose family is `draw` (`.png`/`.jpg`/`.jpeg`/`.pdf`/`.svg` itself excluded).

**Debian's `ffmpeg` package build was not verified for `librsvg` support** -
only the development machine's was. See the Dockerfile's own comment above
the `libheif-examples` line for what to do if an `.svg` -> raster request
fails in production where it worked in development.

### `.heic`/`.heif`: a seventh engine, because `ffmpeg` cannot read either one

This build's `ffmpeg` has no HEIF demuxer or encoder at all (verified by
hand: `ffmpeg -demuxers`/`-decoders` list no `heif` entry), so `.heic`/
`.heif` needed a real seventh conversion engine -
[`heif.engine.ts`](src/engines/heif.engine.ts), running `libheif`'s own
`heif-convert`/`heif-enc` CLIs (Debian/Ubuntu package: `libheif-examples`)
as subprocesses, exactly like `ffmpeg` itself is run.

`heif-convert` decodes a `.heic`/`.heif` source, and writes `jpg`/`jpeg`/
`png`/`tif`/`tiff` directly from it - covering `tiff`/`png-image`/
`jpg-image` in one process. The other four transcode targets (`bmp`/`gif`/
`webp`/`avif`/`ico`) go through an intermediate PNG that `ffmpeg` then
transcodes onward, same as any other `transcode` pair.

`heif-enc` encodes a `.heic`/`.heif` target, but only reads PNG or JPEG
(verified by hand: a `.bmp` input fails with `Not a JPEG file`) - so
producing `heic`/`heif` from any other image source (`.bmp`/`.gif`/`.tiff`/
`.webp`/`.avif`/`.ico`/`.svg`) first runs that source through the ordinary
`ffmpeg` transcode to an intermediate PNG, exactly the step every one of
those sources already takes to reach any other target.

Both tools are checked at boot the same way `ffmpeg`/pandoc/7z are -
`assertHeifPresent` in [`preflight.service.ts`](src/services/preflight.service.ts)
- so a container missing `libheif-examples` fails loudly at startup rather
than on someone's first HEIC upload.

### `.emf`/`.wmf`/`.eps`: the same Draw route as `.svg`, minus the `ffmpeg` half

No new engine and no new package. LibreOffice opens all three the same way it
opens an SVG - as a Draw document - and both directions were verified by hand
against real files (`draw_emf_Import`/`draw_emf_Export`,
`draw_wmf_Import`/`draw_wmf_Export`, `draw_eps_Import`/`draw_eps_Export`).
That gets them `pdf`/`svg`/each other, the same `direct`-mode route `svg`
itself uses.

What they do **not** get is `.svg`'s other half: this build's `ffmpeg` has no
decoder for EMF, WMF or EPS at all, so none of the three reaches
`TRANSCODE_TARGETS` (`bmp`/`gif`/`jxl`/etc) or `heic`/`heif` the way `.svg`
does. They also do not reach the raster `png`/`jpg` targets - those are
reserved for sources with real pages to split one image per page from (a
presentation, or a PDF), which a single-page vector format is not; a plain
image "converting" to a raster target is exactly the confusion
`png-image`/`jpg-image` already exist to avoid, and `test/unit.test.ts`'s own
`routes only presentations and PDFs to the raster pipeline` check enforces it
for every source in the matrix, not just these three.

### `.jxl`/`.jp2`/`.qoi`/`.tga`/`.pcx`/`.apng`: six more `ffmpeg` transcode targets

Same engine as `.bmp`/`.gif`/`.tiff`/`.webp`/`.avif`/`.ico` - appended to
`TRANSCODE_TARGETS` in [`formats.ts`](src/formats.ts), which is what makes
every existing `TRANSCODE_TARGETS` source (and `.svg`/`.heic`/`.heif`, which
reach that list through their own routes) gain all six for free, with no
per-source edit needed. All six were verified by hand, both directions.

`.qoi`/`.tga`/`.pcx`/`.apng` are native `ffmpeg` codecs - no `--enable-*`
build flag of their own, so as safe a bet on a different `ffmpeg` build as
`.bmp`/`.gif` already are. `.jxl`/`.jp2` need `--enable-libjxl`/
`--enable-libopenjpeg` respectively, the same unverified-on-Debian risk
`.svg`'s own `librsvg` flag carries - see the Dockerfile's own comment.

### `.xml`/`.toml`/`.ini`/`.sqlite`: four more members of the data engine

Same `data.service.ts` engine CSV/TSV/JSON/JSONL/YAML already use - one
common JS value, every source read into it, every target written from it.
Three small libraries were added for this (`xml-js`, `smol-toml`, `ini`),
held to the same bar `yaml` already was: the standard tool for its format,
with at most one dependency of its own.

XML and INI need a shape check **this engine performs itself**, because
neither library refuses a bad top-level shape on its own (verified by hand:
both silently turn a scalar's characters or an array's indices into garbage
keys instead of throwing) - XML additionally needs exactly one top-level key,
since a document can have only one root element. TOML's own library already
throws a clear error for a non-object value, so that one is passed through
rather than duplicated.

`.sqlite` is the one member of this group that is bytes, not text - read and
written through `node:sqlite`'s `DatabaseSync` (a Node **built-in** since
22.5, not a dependency - verified by hand against the exact
`node:22-bookworm-slim` image this service's own Dockerfile builds from,
`serialize()`/`deserialize()` included). Reading takes the first user table's
rows as flat records, the same shape CSV/TSV already produce; writing creates
one table named `data`. A multi-table `.sqlite` file is a real shape this
direction cannot reconstruct, the same honest limitation `layers`/`raster`
already have for source shapes they were never meant to produce.

### `tar.zst`: the one archive format `7z` cannot touch at all

`7z` reads and writes gzip/bzip2/xz natively, but has no Zstandard codec in
this build whatsoever - verified by hand, both `7z l` on a real `.zst` file
and `7z a -tzstd` fail with `Unsupported archive type`. So `.zst`/`tar.zst`
route through the standalone `zstd` CLI instead (Debian/Ubuntu package:
`zstd`), in both directions: a `.zst` source has its outer layer undone by
`zstd -d` before `extractArchiveTree` ever runs `7z l` on what's left (which
then goes through the exact same path a plain `.tar` upload would), and a
`tar.zst` target is built the same two-step way `tar.gz`/`tar.bz2` already
are - an intermediate `.tar` from `7z`, then compressed - just with `zstd`
doing the compression step instead of a second `7z a` call.

### `.obj`/`.stl`/`.ply`/`.glb`/`.3mf`/`.off`: a ninth engine, `assimp`

A flat format-to-format tool like `ffmpeg` - `assimp export <in> <out>`
picks both the reader and the writer from each path's own extension, no
per-pair flag needed. Verified by hand for the full matrix this service
advertises (every one of the five write targets, from every one of the six
sources, chained end to end: `obj -> stl -> glb -> ply -> 3mf -> obj`).

`.off` reads but does not write - not an oversight. `assimp listext` lists
it as a real import format; `assimp listexport` does not list it at all, and
asking for it anyway fails outright with "no output format specified and I
failed to guess it". The same asymmetric "one direction is a real, tested
filter and the other is not" shape `.rar` already has elsewhere in this
service (there, read-only because `7z` cannot write it).

A `.obj` *target* writes a companion `.mtl` file alongside it, even from a
source with no materials (verified by hand) - Calibre's writer does this
unconditionally, with no flag to suppress it. This service does nothing
special for it: `collectProducedFiles` already filters by the requested
extension, so the `.mtl` simply never matches and is left behind unread, the
same as any other engine's incidental output file.

Checked at boot the same way `ffmpeg`/`zstd` are - `assertAssimpPresent` in
[`preflight.service.ts`](src/services/preflight.service.ts) - so a container
missing `assimp-utils` (~10MB installed, 3 packages: small) fails loudly at
startup.

### `.epub`/`.mobi`/`.azw3`/`.fb2`/`.lrf`/`.pdb`/`.snb`/KEPUB: a tenth engine, Calibre

The heaviest single addition to this image: `calibre` pulls in ~489MB across
80 packages (mostly its own bundled Qt6/Python stack), because
`ebook-convert` is Calibre's own CLI, not a small standalone tool the way
`heif-convert`/`assimp`/`zstd` are. Verified by hand for the full matrix -
six readable sources into all eight targets, sixty pairs, zero failures.

`epub` itself is NOT a new target id - it already existed, written by
LibreOffice's own Writer EPUB filter for every writer-family source. The
five ebook sources reach that SAME id through a second, non-LibreOffice
route (`engineFrom.ebook`), the identical shape a PDF already uses to reach
`docx`/`pptx`/`xlsx` through `pdf_engine.py` instead of a LibreOffice filter
that does not exist for it.

`.snb` writes but does not read - not an oversight, and the mirror image of
`.off` above. This build's SNB *reader* plugin never populates a document's
title metadata, which crashes nearly every writer trying to read one back
out (`IndexError: list index out of range`, verified by hand against `mobi`/
`azw3`/`lrf`/`fb2`'s own writers - `pdb` is the one exception, since it
happens not to need a title at all). Writing `.snb` from every other source
works fine, which is exactly why there is no `.snb` entry in
`AllowedExtension` at all, only in the target list.

`kepub` needs its OUTPUT path to carry the literal double extension
`.kepub.epub`, not a bare `.kepub` - Calibre's KEPUB writer plugin is only
selected by that exact suffix (verified by hand: the bare form fails with
"No plugin to handle output format: kepub"), the same shape
`tar.gz`/`tar.bz2`/`tar.zst` already use for a genuinely two-part extension.
It needs no SOURCE extension of its own for the read direction: a
`.kepub.epub` upload IS a real EPUB container underneath (verified by hand,
feeding one back into `ebook-convert`), so it already reads correctly under
the ordinary `.epub` bucket `extname()` truncates it to - the same way
`.tar.gz` already reads as a plain `.gz` elsewhere in this matrix.

Checked at boot the same way every other engine is - `assertEbookConvertPresent`
in [`preflight.service.ts`](src/services/preflight.service.ts).

### `.ttf`/`.otf`/`.woff`/`.woff2`: an eleventh engine, `fontTools`

A flat format-to-format tool like `ffmpeg`/`assimp`/`ebook-convert` -
[`scripts/font_engine.py`](scripts/font_engine.py) opens any of the four with
`fontTools.ttLib.TTFont` and writes any other by setting `.flavor` before
`.save()` (`None` for `.ttf`/`.otf`, `'woff'`/`'woff2'` for the other two).
Verified by hand, round-tripped through all four against a real font already
in this repo (`assets/fonts/DancingScript.ttf`, a dependency of the PDF
signature feature).

`.ttf` -> `.otf` (and back) is a CONTAINER swap, not a real TrueType-to-CFF
outline conversion - `fontTools` does not do that implicitly, and this
feature does not claim to. The glyph outlines stay exactly what they were;
only the `sfnt` wrapper's declared flavor changes, which is still a real,
useful conversion (a renderer that insists on the `.otf` extension opens the
result correctly - verified by hand).

Installed via `python3-fonttools` (apt), not pip - the one Python engine in
this service that is. Checked at boot the same shape `assertPdfEnginePresent`
already uses for `pdf_engine.py`'s own dependencies: run `python3 -c "import
fontTools"` and fail loudly if it cannot.

### `.parquet`/`.orc`/`.feather`: a twelfth engine, `pyarrow`, bridged into the data engine

Unlike `.xml`/`.toml`/`.ini` earlier, no comparable JS library exists for any
of these three formats worth trusting the way `xml-js`/`smol-toml`/`ini`
were - so [`scripts/arrow_engine.py`](scripts/arrow_engine.py) (`pyarrow`,
installed via pip - no Debian package exists) is a real subprocess, the same
shape `pdf_engine.py` already is for `docx`/`pptx`/`xlsx`. What makes it
different from every OTHER subprocess engine in this service is where the
bridge sits: not a document format, but JSON - the script reads a `.parquet`/
`.orc`/`.feather` source and writes a JSON array of flat row objects (the
exact shape CSV/TSV's own reader already produces), or the reverse, so
`data.service.ts`'s own common-JS-value model absorbs all three without ever
knowing a subprocess was involved. `arrow.service.ts` is the thin Node-side
wrapper that writes/reads the intermediate JSON file and shells out to the
script; `runDataPipeline` in `conversion.pipeline.ts` is what decides, per
request, whether a source/target needs that door or the ordinary text one.

Verified by hand for the full round trip: CSV -> Parquet -> ORC -> Feather ->
CSV, byte-for-byte the same rows at the end. Checked at boot the same shape
`fontTools` is: `python3 -c "import pyarrow, pyarrow.parquet, pyarrow.orc,
pyarrow.feather"`.

### `.eml`: reaching the existing `txt`/`html` targets, no new engine mode

`.eml` is RFC 822 plain text - unlike `.msg` (proprietary OLE/MAPI, see
below), a real, hand-authorable, verified source. Read by `mailparser`
(pure JS, no subprocess - [`email.service.ts`](src/services/email.service.ts)),
already the standard tool for this in the `nodemailer` ecosystem, the same
bar `yaml`/`xml-js`/`smol-toml` were held to when they were added.

`.eml` reaches the EXISTING `txt`/`html` target ids through
`engineFrom.email` - the identical second-route shape a PDF already uses for
`docx`/`pptx`/`xlsx`, or the ebook sources use for `epub`. `txt` is the
message's own plain-text part, or `mailparser`'s own HTML-to-text fallback
if it only has an HTML part (verified by hand); `html` is the message's own
HTML part, or a minimal wrapper around the plain text if it has none. Both
are prefixed with a short From/To/Subject/Date header block - an email with
no indication of who sent it or when is not a faithful rendering of one.

**`.msg` is NOT in this matrix at all** - not an oversight, the same rule
that already excludes `.rar`. `.msg` is Outlook's proprietary OLE/MAPI
container, and there is no legal way to author a real one to test against
without Outlook itself (extract-msg, the standard Python reader for it, was
confirmed installable, but confirming it actually WORKS needs a real `.msg`
file this project has no way to produce or obtain).

### The two targets LibreOffice does not produce

Every other target in that table is a LibreOffice filter. Two are not, and they
are called `extract` targets in `src/formats.ts`: rather than handing the
document to a converter, the service reads it itself and builds the answer out
of what is inside. That is the only reason a `.docx` can reach a workbook and a
`.psd` can reach an image at all — LibreOffice has no filter that would get
either there.

| Target | From | Answer |
|---|---|---|
| `tables` | `.docx` `.docm` | One `.xlsx`, a worksheet per table |
| `layers` | `.psd` | One PNG per layer, in a ZIP, plus `manifest.json` |

The two differ in what they answer WITH, and that difference is what each
target's `multiple` field records: several tables become several *sheets* of one
workbook, while layers become several *files* in one archive.

#### `XLSX (tables)`

The document is opened as the ZIP of XML parts it already is, its tables are
read out, and the answer is a workbook with one worksheet per table. See
[Extracting tables](#extracting-tables).

It is a target of its own rather than a `.docx` route into `xlsx`, and that is
deliberate. `xlsx` from a spreadsheet is a faithful conversion of the whole
document; this keeps the tables and drops everything else — the prose, the
headings, the images, the styles. If they shared a name then `GET /formats`
would advertise `xlsx` for a `.docx` and the person asking for it would
reasonably expect a Word-faithful workbook. The lossy operation should not
answer to the name of the faithful one, so the distinction lives in the address.

`.doc` deliberately does **not** get this target. It is the same family and the
same audience as `.docx`, but it is a binary container rather than a ZIP, so
there is nothing for the extractor to open.

#### `PNG (layers)`

A Photoshop document is not a document LibreOffice opens, so there is no filter
to write and no document family to key one on — which is why `.psd` is the one
source in the matrix with no `family`, and the only target it offers is this
one. Every layer with pixels becomes a PNG, at the path its group gives it, and
a `manifest.json` describes the lot. See
[Extracting PSD layers](#extracting-psd-layers).

It shares the `.png` extension with the `png` target on purpose, exactly as
`tables` shares `.xlsx`: both write PNG images, and it is the response's shape
rather than its content that differs. The labels are what tell them apart in a
message — `PNG` renders a presentation one image per slide, `PNG (layers)`
writes one image per layer of a PSD — and `multiple` is `true` for both, so a
client never has to guess whether it is unwrapping a ZIP.

A PSD gets no PDF target. LibreOffice's PSD import would be a different feature
with a different name, and advertising it would promise a fidelity nothing in
this pipeline could deliver.

### PDF as a source, and why some of its targets are not LibreOffice either

A PDF opens in LibreOffice as a **Draw** document, full stop — there is no
Writer, Calc or Impress import for it. That is not a gap in the filter table
above; it is verifiable directly: run `soffice --convert-to docx` (or `pptx`,
or `xlsx`) against any real PDF and it fails with `no export filter found`,
every time, on every LibreOffice install. `pdfa` and the `PNG`/`JPG` targets
work from a PDF because they *are* Draw's own export filters — `pdfa` is
Draw's PDF export with `SelectPdfVersion` forced to PDF/A-1b, and the raster
pipeline renders one image per page exactly as it does for a presentation
(skipping the render-to-PDF step, since the upload already is the PDF).

`docx`, `pptx` and `xlsx` reach no LibreOffice filter from a PDF at all — and
still answer to those same three ids, not a lookalike name of their own;
`markdown` has no LibreOffice filter on ANY source, not just a PDF, since
Markdown export does not exist in LibreOffice at all:

| Target | From a PDF | Answer |
|---|---|---|
| `docx` | `.pdf` | One `.docx`, reconstructed from the PDF's own text, tables and images |
| `pptx` | `.pdf` | One `.pptx`, one slide per page, each page as a full-slide image |
| `xlsx` | `.pdf` | One `.xlsx`, a worksheet per **ruled** table found in the PDF |
| `markdown` | `.pdf` | One `.md`, headings/lists/tables recovered by heuristic |

This is a **second, independent conversion engine** —
[`scripts/pdf_engine.py`](scripts/pdf_engine.py), run as a subprocess exactly
as `soffice`/`pdftoppm` are, with the same deadline and the same abort
handling — reached through `engineFrom` in `src/formats.ts` rather than
through `filters`. For `docx`/`pptx`/`xlsx` it is deliberately a second route
to the SAME target id, not a target of its own the way `tables`/`layers`
are: a `.doc` upload asking for `docx` gets a plain `soffice --convert-to`,
and a PDF asking for `docx` gets `pdf_engine.py`, and the client never has to
know or care which one ran — the URL names the FORMAT, and
`resolveConversion` decides the engine. `markdown` has no other route to be
a second one to — it is engine-only, for every source, which is why
`formats.ts`'s `validateMatrix` had to learn a new legitimate shape: a
`direct`-mode target with an EMPTY filter table, reachable purely through
`engineFrom`.

From a PDF, `docx` uses [pdf2docx](https://github.com/dothinking/pdf2docx)
(built on PyMuPDF) to rebuild real paragraphs, tables and images as OOXML —
this is layout reconstruction, not a picture of the page.

**Except for a PDF built entirely on Type3 fonts, where `docx` falls back to
a full-page image per page instead.** Type3 fonts define each glyph as its
own tiny content-stream program rather than a standard outline — common
output from "print to PDF" drivers and older exporters for a script the
driver's base fonts do not cover (found here on an Azerbaijani-language
report; Cyrillic, Vietnamese and various math typesetting hit the same
driver behaviour for the same underlying reason). PyMuPDF's own text
extraction handles these correctly — checked directly against the file that
exposed this — but pdf2docx's layout reconstruction does not: on that file it
duplicated and overlapped every line, and no `pdf2docx` setting (table
detection on or off, stream or lattice) changed that. `pdf_engine.py` checks
for a Type3 font up front (`page.get_fonts()`). With `ocr=true` (the
default), it does NOT fall back to an image at all: the PDF is force-OCR'd
(`_force_ocr_pdf` — the existing Type3 text is exactly what would make
OCRmyPDF's normal skip-text mode refuse to touch the page, so this uses
`force_ocr` instead, which strips it and re-rasters from scratch) and read
back through the same text-only `pdf2docx` `ocr=2` path a genuine scan uses
below — raw recognised text, no embedded images, which is what OCR is for.
The full-page-image fallback only happens if `ocr=false`, or if OCR itself
fails (a missing language pack, a pathological page): a faithful picture of
each page with no text at all, the same result this pipeline gave a Type3
PDF before OCR existed.

**A PDF with no extractable text at all — a scan — is OCR'd before
reconstruction, by default.** pdf2docx has no OCR of its own: its `ocr=1`
("do OCR") setting is an unimplemented stub in the installed version —
`RawPageFitz.py` raises `SystemExit` if it is ever reached, confirmed by
reading the source directly — so a real OCR pass has to run first. This is a
**fifth conversion engine**, [OCRmyPDF](https://ocrmypdf.readthedocs.io/)
(driving [Tesseract](https://github.com/tesseract-ocr/tesseract)), which
writes an invisible, searchable text layer behind the scanned page without
touching how it looks; `pdf2docx` then reads that layer instead of the
(nonexistent) visible text, via its own `ocr=2` mode. This only ever runs on
a PDF with **no text on any page** — a document that already has real text
next to a legitimate image is left alone, because `ocr=2` is a document-wide
switch that discards every page's embedded images in favour of the OCR text,
which would wrongly delete a real picture on a page that was never scanned.
Send `ocr=false` on `/convert/docx` to skip this and get the scan as a plain
embedded image instead, with no selectable text — the same result this
endpoint always gave a scan before this feature existed. An OCR failure (a
missing language pack, a pathological image) degrades to that same
plain-image result rather than failing the request: OCR here is a
best-effort enhancement to an already-working target, not a target of its
own. Tesseract ships with English, Azerbaijani, Turkish and Russian language
data by default (`OCR_LANGUAGES`, `+`-joined tesseract codes, to change it).

**Both OCR calls pin `output_type='pdf'`, `optimize=0` and `jobs=1` -
measured necessities, not tuning.** OCRmyPDF's own defaults
(`output_type='pdfa'`, `optimize=1`) add a second full Ghostscript rendering
pass and a pikepdf-based recompression pass, for a PDF/A-conformant file
this pipeline only ever reads the text back out of and then discards; its
default per-page multiprocessing (`jobs`) holds several rasterised pages in
memory at once. A real 6MB, 10-page PDF OOM-killed the whole container under
this service's own `mem_limit: 1g` (`docker-compose.yml`) with OCRmyPDF's
defaults, and completed cleanly - slower, at around 200MB peak - with these
three set. If `OCR_LANGUAGES` or `mem_limit` change, re-check this: OCR is
by far the most memory-hungry thing in this container.

`pptx` has no editable-shapes equivalent to fall back on — there is no
PDF-to-Impress import to reconstruct from — so it does what real "PDF to
PowerPoint" tools do for anything that is not already a native deck: render
each page and place it as that slide's image, sized to match. The deck is a
genuine `.pptx` a person can open, present from and add slides to; the layout
is pixel-perfect and none of the text is editable.

`xlsx` uses [pdfplumber](https://github.com/jsvine/pdfplumber) to find tables
by their drawn lines, lossy in the same direction as `tables` and for the same
reason: prose and images are dropped, and a table set with whitespace alone
and no visible ruling will not be found. A PDF with no detected table answers
`E_NO_TABLES`, exactly as `tables` does for a Word document with none — the
one place this route is a genuinely different, lossier operation from what
`xlsx` means for every other source, and it still answers to the name, because
a workbook is a workbook and there is no faithful, non-lossy PDF→spreadsheet
export to hold it apart from.

`markdown` uses PyMuPDF for text and pdfplumber for tables, the same two
libraries `docx`/`xlsx` already use, combined differently: each page's text
blocks and detected tables are sorted together by vertical position, so a
table renders inline where it actually sits rather than trailing the page's
prose. Headings, bullet/numbered lists and bold text are recovered by
**heuristic, not structure** — a PDF has no heading elements the way a
`.docx` package does, so a line's font size is judged against **this
document's own median span size** (not a fixed point size, since a deck set
entirely in 20pt text and a memo set in 10pt text each need headings judged
against their own "normal") and rendered as `#`/`##`/`###` above three
relative-size thresholds; a bold line at body size becomes `**text**`
instead. This will occasionally misjudge a large pull-quote as a heading, or
miss a heading set apart by color alone rather than size — accepted the same
way `xlsx`'s lines-based table detection accepts a borderless table it
cannot see. Unlike `xlsx`, an empty result is not an error: a blank or
image-only PDF producing an empty (or near-empty) Markdown file is an honest
answer, not a failure, the same as `.docx → txt` on a blank document.

---

## Quick start

```bash
npm install
npm run build
npm start          # http://localhost:3001
```

The service **refuses to boot** if LibreOffice is missing, if the rasteriser is
missing, if the metric-compatible fonts are not installed, if the PDF
engine's Python dependencies are not importable, if `qpdf` is missing, if
`pandoc` is missing, if `7z` is missing, or if `ffmpeg` is missing — see
[Fonts](#fonts-and-why-they-are-not-optional). A missing `tesseract` is the
one exception: it is logged as a warning at boot, not a boot refusal, because
OCR is a best-effort enhancement to a target that already works without it —
see [PDF as a source](#pdf-as-a-source-and-why-some-of-its-targets-are-not-libreoffice-either).
On a bare Debian/Ubuntu box:

```bash
sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
  poppler-utils \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fontconfig \
  python3 python3-pip qpdf pandoc p7zip-full ffmpeg \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-aze tesseract-ocr-tur tesseract-ocr-rus
sudo fc-cache -f
pip3 install --break-system-packages pdf2docx pdfplumber python-pptx openpyxl python-docx ocrmypdf
```

Running the test suite additionally needs `genisoimage` (or `xorriso`), to
build a real `.iso` fixture for the archive-engine tests:
`sudo apt-get install -y genisoimage`.

All four LibreOffice modules are required, not just the writer. They are
separate packages, and a machine with only `libreoffice-writer` converts every
Word document perfectly while failing every spreadsheet and every presentation.

The `pip install` is a **second, unrelated** dependency: it has nothing to do
with LibreOffice and exists only for `docx`/`pptx`/`xlsx` requested from a
PDF - see
[PDF as a source](#pdf-as-a-source-and-why-some-of-its-targets-are-not-libreoffice-either).
`--break-system-packages` installs into the system site-packages rather than
`--user`, which matters because the service sandboxes each conversion's `HOME`
- see `pdf-engine.engine.ts` for why a `--user` install would go missing at
request time even though `pip show` finds it fine.

Or just use Docker, which installs all of it:

```bash
docker compose up -d --build
curl -sS http://localhost:3010/health      # {"status":"ok"}
```

`-d` matters: `docker compose up` in the foreground stops both the container and
the service when you press Ctrl+C, and `restart: unless-stopped` deliberately
will not bring back a container you stopped yourself. If a URL that worked
suddenly stops answering, `docker compose ps` distinguishes "broken" from "not
running" in one line.

---

## Command-line tool

`npm install` also gives you `converter`, a local CLI twin of the HTTP API:
same conversion engines (LibreOffice, pandoc, ffmpeg, qpdf, Calibre, assimp,
etc), driven directly against files on disk instead of over HTTP — no rate
limit, no upload ceiling and no `CONVERT_TIMEOUT_MS` deadline, since those
exist to protect a shared host from the public internet and neither concern
applies to your own files on your own machine (see
[`src/cli/index.ts`](src/cli/index.ts)).

```bash
npm run cli -- convert pdf report.docx
npm run cli -- convert png slides.pptx --out ./images
npm run cli -- pdf merge a.pdf b.pdf c.pdf
npm run cli -- pdf split report.pdf --every 5
npm run cli -- pdf rotate scan.pdf --degrees 90
npm run cli -- pdf protect secret.pdf --password hunter2
npm run cli -- media mp3 podcast.wav
npm run cli -- formats
npm run cli -- doctor
```

After `npm run build`, the same commands are available as `converter` (the
package's `bin` entry, `dist/cli/index.js`) — either run directly against a
global/local install, or via `npx converter ...` from a project that depends
on this package.

| Command | Does |
|---|---|
| `converter convert <target> <file> [file2 ...] [--out <dir>] [--ocr=false]` | Same conversions `POST /convert/{target}` offers, against local files |
| `converter media <target> <file> [file2 ...] [--out <dir>]` | Same audio/video conversions `POST /media/{target}` offers, run synchronously (no job polling needed locally) |
| `converter pdf <operation> <file> [flags]` | The page-level PDF operations behind these `/pdf/*` routes — `merge`, `split`, `remove` (`remove-pages`), `extract` (`extract-pages`), `organize`, `scan` (`scan-to-pdf`), `rotate`, `watermark`, `crop`, `page-numbers`, `protect`, `unlock`, `repair`, `compress`. The routes that take structured input or run OCR — `sign`, `edit`, `redact`, `fill-form`, `form-fields`, `compare`, `ocr` — are HTTP-only; there is no CLI command for them |
| `converter formats` | Prints the conversion matrix `GET /formats` serves |
| `converter doctor` | Checks that the system tools this relies on (LibreOffice, ffmpeg, pandoc, qpdf, Calibre, assimp, 7z, poppler, ...) are installed and on `PATH` |

Run `converter --help` (or `converter pdf` with no further arguments) for the
full flag reference, including the `--pages`/`--order` selection syntax
(`1,3,5-7`) the page operations share with the HTTP API.

---

## API

### POST /convert/{target}

`multipart/form-data` with one or more file parts, all named `files`. The
target is part of the path and is **required**.

Upload **exactly one file** and you get back exactly what this endpoint has
always returned: the converted file itself (or its own archive, for an image
target). Upload **two or more** and each is converted independently against
the same target; the response is always one ZIP holding every result -
`01-report.pdf`, `02-invoice.pdf`, ... - plus an `errors.json` entry for any
file that failed, so one bad file in a batch does not lose the rest.

```bash
curl -F "files=@report.docx;type=application/octet-stream" \
     https://converterapi.example.com/convert/pdf \
     -o report.pdf

curl -F "files=@sheet.csv" https://converterapi.example.com/convert/xlsx -o sheet.xlsx
curl -F "files=@deck.pptx" https://converterapi.example.com/convert/png -o slides.zip

# Two or more files -> always a ZIP of results, one entry per input file:
curl -F "files=@report.docx" -F "files=@notes.docx" \
     https://converterapi.example.com/convert/pdf -o converted.zip

# Optional, only meaningful for a scanned PDF -> docx (default is "true"):
curl -F "files=@scan.pdf" -F "ocr=false" \
     https://converterapi.example.com/convert/docx -o scan.docx
```

There is deliberately no bare `/convert` that assumes a format. One address that
means one thing is easier to document, to test and to reason about than two that
mean the same thing, and `POST /convert/pdf` is not harder to write than
`POST /convert`. A request to the bare path falls through to the catch-all
`404`, whose message — *"The converter is not available at this address. Please
update the app and try again."* — is, by accident, exactly the right thing to
say to a client built against the old path.

The import filter is chosen from the **filename extension**, not the declared
MIME type: the client deliberately sends `application/octet-stream`, and a
hostile client could declare anything at all. Any extension in the
[conversion matrix](#conversion-matrix) is accepted (case-insensitive).

**Success** — `200` with the target's own media type (`application/pdf` for
`pdf`, and nothing else), plus a `Content-Disposition` filename.

The **image targets are the exception**: `png` and `jpg` answer with
`application/zip` containing `slide-1.png`, `slide-2.png`, … — one image per
page. That is true even for a one-page document, deliberately: if the content
type varied with the page count, every client would have to sniff what it
received to know whether to unzip it.

**Failure** — `4xx`/`5xx`, `Content-Type: application/json`:

```json
{"error": {"code": "E_CONVERT_FAILED", "message": "This document could not be converted. It may be damaged or in a format the converter does not support."}}
```

`message` is shown **verbatim** in a dialog on the phone, so it is written for a
person: a complete sentence, no stack traces, no paths, no codes. `code` is for
logs and metrics only — the client never shows it.

#### Download filenames

The response offers the uploaded file's name with the new extension, so
`Quarterly report.docx` converted to PDF downloads as `Quarterly report.pdf`.
Converting three documents should not produce three files called
`converted.pdf`.

The name comes from a hostile client and ends up in a response header, so it is
sanitised rather than trusted: path segments and control characters are removed
(a `CRLF` in a filename is a header-injection vector), a leading dot is stripped
so the result is not a hidden file, and the length is capped at
`MAX_DOWNLOAD_NAME_LENGTH`. A name with nothing usable left in it becomes
`converted.<ext>`. Only the final extension is replaced, so
`archive.tar.gz` → `archive.tar.pdf`.

It is sent in both RFC 6266 forms — a quoted ASCII `filename` for older clients
and a percent-encoded UTF-8 `filename*` for current ones — so `Résumé.docx`
arrives as `Résumé.pdf` rather than as mojibake. The ASCII form is derived by
decomposing accents first, so it reads `Resume.pdf` rather than `R_sum_.pdf`.

#### Non-ASCII names, and the decoding trap

**multer hands over every byte of the client's UTF-8 as a separate Latin-1
character.** A file named `KÖKLƏR.docx` arrives as `KÃKLÆR.docx`: `Ö` is
`C3 96` in UTF-8, and read one byte at a time that is `Ã` followed by a C1
control character — invisible in a terminal, and noise wherever it is shown.
This is busboy's behaviour and it is not configurable.

`decodeUploadName` undoes it by re-encoding the code points as bytes and
decoding them as UTF-8, and it is deliberately careful about the two cases
where that would be wrong:

- a name that is already correct — including any character above `U+00FF`,
  which Latin-1 cannot represent, so seeing one proves the string was decoded
  properly already;
- a name that was genuinely Latin-1, like `café` sent as single bytes. Those
  bytes are not valid UTF-8, so the decode fails and the original stands.

Getting this wrong is silent in both directions, which is why
[`test/unit.test.ts`](test/unit.test.ts) pins the round trip for a real
Azerbaijani filename and asserts that the names which must not change do not.

### POST /media/{target} — asynchronous audio/video conversion

A separate endpoint from `POST /convert/{target}`, on purpose. Real
audio/video work breaks three assumptions the rest of this service depends
on:

1. **`CONVERT_TIMEOUT_MS`** (90s) / the Android client's 120s abort — a real
   transcode routinely runs for minutes.
2. **`MAX_UPLOAD_BYTES`** (100MB) — pinned to the Android client's wire
   contract and to Cloudflare's own 100MB edge ceiling; video work would
   ideally take more, but there is nowhere above that limit for it to go.
3. **The synchronous one-request-one-file model** — a client cannot hold a
   connection open for a transcode that may take a while, and nothing about
   `/convert/{target}`'s own contract changes to accommodate one that can.

So `/media/{target}` answers `202` the moment the upload is accepted and
validated, with a job id to poll — it does not wait for the conversion
itself:

```bash
# 1. Submit - 202, with a job id
curl -F "files=@lecture.wav" https://converterapi.example.com/media/mp3
# {"id":"…","status":"queued","statusUrl":"/media/jobs/…"}

# 2. Poll status until it is no longer queued/running
curl https://converterapi.example.com/media/jobs/<id>
# {"id":"…","status":"done","target":"mp3","downloadUrl":"/media/jobs/…/download","bytes":123456}

# 3. Download the result
curl https://converterapi.example.com/media/jobs/<id>/download -o lecture.mp3
```

**Formats.** Audio: `mp3`, `wav`, `flac`, `ogg`, `aac`, `m4a`, `wma`, `opus`,
`aiff`, `m4b`, `ac3`, `au`, `caf`, `oga`, `voc`. Video: `mp4`, `webm`, `mkv`,
`avi`, `mov`, `flv`, `asf`, `f4v`, `m4v`, `mpeg`, `ogv`, `ts`, `wmv`. A source only ever reaches a
target of the SAME kind (audio to audio, video to video) — extracting an
audio track from a video file is a real, different feature this endpoint
does not offer. This list is deliberately smaller than audio/video support
could in principle cover: every entry was verified by hand against the real
`ffmpeg` build this service runs, the same standard held everywhere else in
this service, rather than assumed from ffmpeg's own documentation. See
[`formats-media.ts`](src/formats-media.ts) for the wider list a future pass
could verify and add, one line at a time, the same way this one was built.

**The job store is in-memory, on purpose.** "No database, no state" is this
service's own design from the start, and the job store here is exactly what
that allows: a `Map`, lost on restart. A job a deploy interrupts is a job the
client resubmits — the same as an in-flight `/convert/{target}` request
during a restart, this endpoint does not pretend to a durability the rest of
the service does not have either.

**Its own concurrency pool**, `MAX_CONCURRENT_MEDIA_JOBS` (default 1),
entirely separate from `MAX_CONCURRENT_CONVERSIONS`. A video transcode is a
heavier, much longer-running neighbour than a document conversion, and the
two must never compete for the same slots — two video jobs running at once
must not be able to starve every ordinary `/convert/{target}` request for
the next twenty minutes.

**Its own workspace root, `MEDIA_TEMP_ROOT`**, a *sibling* of `TEMP_ROOT`
rather than a subdirectory of it. `sweepStaleWorkspaces` deletes whatever
direct child of `TEMP_ROOT` looks older than `STALE_WORKSPACE_MS` (15
minutes by default) — exactly right for a synchronous request, and exactly
wrong for a job that can legitimately run for `MEDIA_CONVERT_TIMEOUT_MS` (30
minutes by default): nesting the two under one root would risk the generic
sweep deleting an entire in-progress job the moment its container
directory's own mtime looked stale enough. Media jobs get two sweeps of
their own instead: `sweepMediaJobs` removes a finished job's workspace
`MEDIA_JOB_TTL_MS` after it completed (success or failure — there is nothing
left to download either way once that window passes), and
`sweepOrphanedMediaWorkspaces` is the crash backstop for a workspace whose
in-memory job record a restart lost, with a deliberately generous threshold
(`MEDIA_CONVERT_TIMEOUT_MS + MEDIA_JOB_TTL_MS`) so it can never race a job
that is merely slow.

**Job status**:

| `status` | Meaning |
|---|---|
| `queued` | Accepted, waiting for a media-job slot. |
| `running` | Converting. |
| `done` | `downloadUrl` and `bytes` are present; `GET .../download` returns `200`. |
| `failed` | `error` (`{code, message}`) is present; `GET .../download` returns the same envelope, at the status code that failure would have used had it happened synchronously (`500` for `E_CONVERT_FAILED`, `504` for `E_TIMEOUT`). |

Downloading before the job reaches `done` answers `409 E_JOB_NOT_READY`;
naming a job id that never existed, or was swept after its TTL, answers
`404 E_JOB_NOT_FOUND`.

**Resource caps raised for this endpoint specifically** — see
[Configuration](#configuration) for the exact variables. The container's own
`mem_limit`/tmpfs size were raised alongside them (see
[`docker-compose.yml`](docker-compose.yml)'s own comments): `MEDIA_MAX_UPLOAD_BYTES`
now defaults to the same 100MB `MAX_UPLOAD_BYTES` uses — Cloudflare's own edge
refuses any request body over 100MB before nginx or this service ever see it,
so a separate, larger ceiling here would be dead configuration — and that
upload lands on the same tmpfs `/tmp` the document-conversion workspaces
already share, which is RAM, not disk.

### POST /pdf/{merge,split,remove-pages,extract-pages,organize,scan-to-pdf}

Six page-level PDF operations, kept apart from `/convert/{target}` because
none of them fit its shape: a merge takes several files and no target; split
takes one file plus a page-count field; remove/extract/organize each take one
file plus a page-selection field. None of that is a `/convert/{target}`
request no matter how it is squeezed.

They share the admission gate (rate limit and queue capacity), the workspace
lifecycle and the response shape with `/convert/{target}` — everything except
the input shape and the operation itself.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/merge` | 2+ PDFs, field `files` | One merged PDF, pages in upload order |
| `POST /pdf/split` | One PDF, field `file`, text field `every` (default `1`) | A ZIP of `part-1.pdf`, `part-2.pdf`, … |
| `POST /pdf/remove-pages` | One PDF, field `file`, text field `pages` | The PDF minus the named pages |
| `POST /pdf/extract-pages` | One PDF, field `file`, text field `pages` | A PDF of only the named pages, in the order given |
| `POST /pdf/organize` | One PDF, field `file`, text field `order` | The PDF reordered to `order` |
| `POST /pdf/scan-to-pdf` | 1+ images, field `files` | One PDF, one page per image, sized to it |

```bash
curl -F "files=@jan.pdf" -F "files=@feb.pdf" -F "files=@mar.pdf" \
     https://converterapi.example.com/pdf/merge -o q1.pdf

curl -F "file=@report.pdf" -F "every=5" \
     https://converterapi.example.com/pdf/split -o chunks.zip

curl -F "file=@contract.pdf" -F "pages=2,7" \
     https://converterapi.example.com/pdf/remove-pages -o contract-clean.pdf

curl -F "file=@scan.pdf" -F "order=3,1,2" \
     https://converterapi.example.com/pdf/organize -o scan-reordered.pdf

curl -F "files=@page1.jpg" -F "files=@page2.jpg" \
     https://converterapi.example.com/pdf/scan-to-pdf -o scanned.pdf
```

**None of this touches LibreOffice or `pdf_engine.py`.** It runs on
[`pdf-lib`](https://github.com/Hopding/pdf-lib) in-process — no subprocess, no
profile directory, no deadline — because the work is moving pages between PDF
structures, not converting a document from one format to another. The closest
relative in this codebase is the `tables`/`layers` extractors, for the same
reason: the work is this service's own, not a program it shells out to.

**The page-selection syntax** (`pages`, `order`) is 1-based page numbers and
inclusive ranges, comma separated: `2,5-7,10`. Order and duplicates are
preserved exactly as written — `3,1,2` reorders, `1,1` duplicates page 1 — and
a page outside the document, or malformed syntax, is a `400 E_BAD_PAGE_RANGE`
naming the specific problem (`"Page 9 does not exist in this 5-page
document."`), not a generic bad-request sentence.

**`extract-pages` and `organize` do the same underlying work** — build a new
PDF from an ordered list of source pages — but enforce different rules on the
list before running it: `extract-pages` accepts any subset (that is the point
of "extract"), while `organize` requires `order` to name **every** page
exactly once, so a typo that would silently drop a page is refused instead of
producing a shorter document nobody asked for. Dropping a page on purpose is
`/pdf/remove-pages`'s job, not `organize`'s.

**`merge` and `scan-to-pdf` need at least two files and one file respectively**
— `400 E_TOO_FEW_FILES` otherwise — and both cap the *combined* size of every
file in the request (`MAX_PAGE_OPERATION_TOTAL_BYTES`, default 100MB) as well
as the file count (`MAX_PAGE_OPERATION_FILES`, default 20): `MAX_UPLOAD_BYTES`
alone bounds one file, and these endpoints can be handed several.

Every PDF these endpoints accept is checked for a password first, exactly as
`/convert/{target}` checks a PDF — see [Password-protected
documents](#password-protected-documents) — because pdf-lib on an encrypted
PDF would otherwise fail with the same unhelpful "damaged" message LibreOffice
gives.

### POST /pdf/{rotate,watermark,protect,unlock}

Four more page-level operations, each one PDF plus one or two text fields —
the same shape `remove-pages`/`extract-pages`/`organize` already use.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/rotate` | One PDF, field `file`, text field `degrees` (multiple of 90), optional `pages` | The PDF with the named pages (or all) rotated |
| `POST /pdf/watermark` | One PDF, field `file`, text field `text`, optional `pages` | The PDF with `text` stamped across the named pages (or all) |
| `POST /pdf/protect` | One PDF, field `file`, text field `password` | The same PDF, encrypted with `password` |
| `POST /pdf/unlock` | One encrypted PDF, field `file`, text field `password` | The same PDF, decrypted |

```bash
curl -F "file=@scan.pdf" -F "degrees=90" -F "pages=1,3" \
     https://converterapi.example.com/pdf/rotate -o scan-rotated.pdf

curl -F "file=@contract.pdf" -F "text=DRAFT" \
     https://converterapi.example.com/pdf/watermark -o contract-draft.pdf

curl -F "file=@contract.pdf" -F "password=hunter2" \
     https://converterapi.example.com/pdf/protect -o contract-locked.pdf

curl -F "file=@contract-locked.pdf" -F "password=hunter2" \
     https://converterapi.example.com/pdf/unlock -o contract.pdf
```

**`rotate` and `watermark` are `pdf-lib`**, the same as every other page
operation — `rotate` adds `degrees` to whatever rotation a page already
carries rather than replacing it, and `watermark` draws its text horizontally
(not at a diagonal: poppler's `pdftotext`, and other tooling like it, commonly
falls back to one character per line for a rotated glyph run, which buys
nothing visually and makes the result harder for downstream tools to read).
Both default to every page when `pages` is omitted.

**`protect` and `unlock` are not `pdf-lib` at all.** `pdf-lib` is explicit in
its own README that PDF encryption is out of scope for it — there is no path
in it that sets or removes a password. These two endpoints shell out to
[`qpdf`](https://qpdf.sourceforge.io/) instead, a small, dependency-free CLI
built for exactly this, reusing the same subprocess runner (`runProcess` in
`soffice.engine.ts`) that LibreOffice and `pdf_engine.py` use — the failure
modes are identical (a wedged process, a client that left, a shared
deadline), so there is no reason to write a second copy of handling them.

`protect` refuses a file that is already encrypted with the usual
`422 E_ENCRYPTED` — re-encrypting an already-encrypted file without first
supplying the password it already has is not a coherent request. `unlock` is
the mirror image: it deliberately **skips** that check, since the whole point
of the endpoint is that the input is encrypted, and a wrong password against
it is its own error, `422 E_WRONG_PASSWORD` — distinct from `E_ENCRYPTED`
because it means something different: not "refused because it's locked" but
"tried, and that password doesn't open it."

### POST /pdf/{crop,page-numbers,repair}

Three more, rounding out the page-level family.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/crop` | One PDF, field `file`, text fields `left`/`right`/`top`/`bottom` (points, default `0`), optional `pages` | The PDF with the named pages (or all) cropped |
| `POST /pdf/page-numbers` | One PDF, field `file`, text fields `position` (default `bottom-center`), `startAt` (default `1`) | The PDF with a number drawn on every page |
| `POST /pdf/repair` | One PDF, field `file` — no other fields | The same PDF, rewritten to fix whatever qpdf's reader could recover |

```bash
curl -F "file=@scan.pdf" -F "left=10" -F "right=10" -F "top=20" \
     https://converterapi.example.com/pdf/crop -o scan-cropped.pdf

curl -F "file=@report.pdf" -F "startAt=1" -F "position=bottom-right" \
     https://converterapi.example.com/pdf/page-numbers -o report-numbered.pdf

curl -F "file=@broken.pdf" \
     https://converterapi.example.com/pdf/repair -o fixed.pdf
```

**`crop` and `page-numbers` are `pdf-lib`**, the same as rotate and watermark.
`crop` shrinks the crop box rather than touching page content — the trimmed
area still exists in the file, only outside what a viewer or printer shows —
and refuses margins that would leave nothing with `400 E_INVALID_FIELD` —
the numbers themselves are the problem, not the document, which is what that
code means everywhere else it appears. `page-numbers` counts up by one
starting at `startAt`, for every
page in document order; there is no "number some pages" mode, because a page
number that disagrees with its own position in the document would be worse
than none at all.

**`repair` is `qpdf`**, the same engine as `protect`/`unlock`. Plain
`qpdf in out` already does the repair: qpdf's own reader recovers what it can
while parsing a damaged cross-reference table, a truncated update or a broken
linearization hint stream, and writing the file back out is what makes that
recovery permanent — the same idea as "open and re-save" fixing a shaky Office
document. qpdf reports this outcome as **exit code 3** ("warnings, but the
file was still written"), which this endpoint treats as success — that is
exactly the case `/pdf/repair` exists for, not a failure. It refuses an
encrypted input the same as every other page endpoint; there is nowhere to
put a password on this one.

### POST /pdf/ocr

Makes a scanned PDF searchable, as a standalone result rather than only as the
internal first step of a PDF-to-`docx` conversion.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/ocr` | One PDF, field `file`, optional text field `force` (default `false`) | The same PDF, with an invisible OCR text layer behind each scanned page |

```bash
curl -F "file=@scan.pdf" \
     https://converterapi.example.com/pdf/ocr -o scan-searchable.pdf

curl -F "file=@type3-report.pdf" -F "force=true" \
     https://converterapi.example.com/pdf/ocr -o report-searchable.pdf
```

**This is `pdf_engine.py`'s existing OCR pipeline (OCRmyPDF + Tesseract),
exposed directly** rather than only running as `/convert/docx`'s internal
scan-detection step — see [PDF as a source](#pdf-as-a-source-and-why-some-of-its-targets-are-not-libreoffice-either).
With `force=false` (the default), a PDF that already has real extractable
text on every page is returned unchanged — there is nothing to OCR, and this
is not an error. A PDF with no extractable text (a genuine scan) is OCR'd.
`force=true` re-OCRs regardless of what text is already there, discarding it
first — the same escape hatch `convert_to_docx` uses internally for a
Type3-font PDF, whose existing "text" is exactly what corrupts a normal
reader rather than being usable.

### POST /pdf/compress

Shrinks a PDF's file size by recompressing its internal streams and images.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/compress` | One PDF, field `file`, optional text field `level` (`low`/`medium`/`high`, default `medium`) | The same PDF, recompressed |

```bash
curl -F "file=@report.pdf" -F "level=high" \
     https://converterapi.example.com/pdf/compress -o report-small.pdf
```

**This is `qpdf`, not a new engine.** `qpdf` has no lossy image-quality dial
(there is no `--jpeg-quality` flag, despite what several other PDF tools
offer) — its own lever is `--optimize-images`, which re-encodes an image as
JPEG only when that comes out smaller, gated by a minimum width/height/area
so tiny images are left alone. `level` controls how many images qualify for
that re-encoding (`low` touches no images at all, stream recompression only;
`high` makes every image, however small, a candidate) rather than how much
quality is sacrificed, because that is the only axis qpdf actually exposes.
An already-encrypted upload is refused with the usual `422 E_ENCRYPTED`, the
same as every other page endpoint. Unlike `/pdf/repair`, qpdf's exit code 3
("recovered with warnings") is **not** treated as success here — silently
repairing a broken file would be a surprising side effect of a request that
only asked for a smaller one.

### POST /pdf/{form-fields,fill-form}

Reads and fills a PDF's AcroForm fields.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/form-fields` | One PDF, field `file` | JSON: every field's name, type and current value (or options, for a dropdown/radio/option list) |
| `POST /pdf/fill-form` | One PDF, field `file`, text field `fields` (a JSON object of field name → value), optional text field `flatten` (default `false`) | The PDF with those fields filled |

```bash
curl -F "file=@application.pdf" \
     https://converterapi.example.com/pdf/form-fields

curl -F "file=@application.pdf" \
     -F 'fields={"Full Name":"Jane Doe","Agree":true}' \
     -F "flatten=true" \
     https://converterapi.example.com/pdf/fill-form -o application-filled.pdf
```

**Both are `pdf-lib`'s own AcroForm API** — no new engine. A PDF with no
AcroForm at all answers `/pdf/form-fields` with an empty array, not an error:
the file opened fine and genuinely has nothing to extract, the same
philosophy as `E_NO_TABLES`/`E_NO_LAYERS` elsewhere in this service, just
without needing a dedicated error code since an empty JSON array is already
an unambiguous answer. `/pdf/fill-form` names the specific field in its error
when `fields` names one that does not exist on the form, or gives a value of
the wrong shape for that field's type (e.g. a string for a checkbox) —
`400 E_INVALID_FIELD`, not a generic failure. `flatten=true` bakes the filled
values into the page content and removes the fields themselves, for a
"final", no-longer-editable copy.

### POST /pdf/compare

A per-page text diff between two PDFs.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/compare` | Exactly two PDFs, field `files` | JSON: a per-page diff, plus page-count metadata |

```bash
curl -F "files=@contract-v1.pdf" -F "files=@contract-v2.pdf" \
     https://converterapi.example.com/pdf/compare
```

Returns `{"pageCountA":.., "pageCountB":.., "pages":[{"page":1,"equal":true},
{"page":2,"equal":false,"diff":[...]}], "extraPagesInA":[...],
"extraPagesInB":[...]}`, 1-based throughout — deliberately not this
codebase's usual 0-based `pdf-lib` convention, since this is JSON-API-facing
output from a different layer (`pdf_engine.py`), not an internal page index.

**This runs through `pdf_engine.py`, not `pdf-lib`.** `pdf-lib` has no text
extraction of its own, and this service's only text-extraction capability
already lives in the Python side (`fitz`/PyMuPDF), used elsewhere for the
Type3-font and no-extractable-text checks that gate OCR — see
[PDF as a source](#pdf-as-a-source-and-why-some-of-its-targets-are-not-libreoffice-either).
Each shared page is diffed line-by-line with Python's own `difflib`; pages
beyond the shorter document's page count are reported separately as
`extraPagesInA`/`extraPagesInB` rather than forced into a same-length
comparison. Anything other than exactly two files is `400 E_TOO_FEW_FILES`
("Comparing needs exactly two PDF files.").

### POST /pdf/sign

Stamps a visual signature, initials, name, date, free text or company stamp
onto a PDF, at caller-given positions.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/sign` | One PDF (`file`), a JSON array of placements (`elements`), zero or more PNG/JPG images (`images`) | The PDF with every element drawn onto its page |

```bash
curl -F "file=@contract.pdf" \
     -F 'elements=[{"type":"signature","page":1,"x":72,"y":700,"width":180,"height":50,"value":"Jane Doe","fontStyle":"cursive","color":"blue"},{"type":"date","page":1,"x":72,"y":760,"width":100,"height":20,"value":"2026-09-20"}]' \
     https://converterapi.example.com/pdf/sign -o contract-signed.pdf
```

Each element in `elements` is one of `signature`/`initials`/`stamp` (typed as
text via `value`, or drawn/uploaded as an image via `imageIndex` into
`images` — `stamp` only ever comes from an image) or `name`/`date`/`text`
(always `value`, always text). `x`/`y` are the element's **top-left** corner
in points, the natural coordinate system a browser canvas overlay reports —
the server flips this to `pdf-lib`'s bottom-left origin internally.

**This is a visual mark only, not a cryptographic signature.** It bakes text
or an image permanently into the page content — the same category of
operation as `/pdf/watermark`/`/pdf/page-numbers`, just with caller-chosen
positions and several element types instead of one fixed formula — and
carries none of the guarantees a real PKI-based digital signature makes
(tamper-evidence, identity verification against a trust chain). A genuine
certificate-based signing endpoint would need a real key-management story
(whose certificate signs the file, and how its private key is handled) that
has not been built. Typed `signature`/`initials` text can be rendered in one
of three `fontStyle`s: `cursive` (an embedded, OFL-licensed handwriting font,
`assets/fonts/DancingScript.ttf`, embedded via `@pdf-lib/fontkit` since
`pdf-lib`'s own `StandardFonts` has no script font at all), `cursive2` (a
bold-oblique variant, for a second distinct look without a second embedded
font), or `plain` (Helvetica). SVG signature/stamp uploads are not accepted
(PNG/JPG only, the same as `/pdf/scan-to-pdf`) — rasterising arbitrary SVG
would need its own conversion step this pipeline does not have.

### POST /pdf/redact

Permanently removes text and vector content under caller-given rectangles —
not a black box drawn on top of it.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/redact` | One PDF, field `file`, text field `areas` (a JSON array of `{page, x, y, width, height}`) | The PDF with that content genuinely removed and replaced with a black fill |

```bash
curl -F "file=@case-file.pdf" \
     -F 'areas=[{"page":1,"x":72,"y":600,"width":250,"height":18}]' \
     https://converterapi.example.com/pdf/redact -o case-file-redacted.pdf
```

`page` is 1-based; `x`/`y`/`width`/`height` are in points, **top-left
origin** — the same convention `/pdf/sign`'s `elements` already use, so a
frontend built against one reuses the other's coordinate math unchanged.

**This is `pdf_engine.py`/PyMuPDF, not `pdf-lib`**, and deliberately so:
drawing a filled rectangle over content with `pdf-lib` would leave the
original text and images sitting untouched underneath it in the file — every
PDF text-extraction tool, and plenty of ordinary PDF viewers, would still
read the "redacted" secret right through it. PyMuPDF's own redaction
annotations (`add_redact_annot` + `apply_redactions`) actually strip the
glyphs and vector content intersecting each rectangle from the page's
content stream, confirmed directly before this was built: a page holding
`"SECRET"` immediately next to `"KEEP"` inside one rectangle-adjacent region,
redacted over just the first word, comes back from text extraction as
`"KEEP"` with `"SECRET"` **absent entirely**, not merely invisible.

**The one real limitation, and it matters**: redaction happens at whatever
granularity the content stream already stores text in, not at the word
level — a rectangle that only partially covers a word removes exactly the
glyphs it overlaps and leaves the rest intact and readable (confirmed: a
rectangle over the left half of `"HelloWorld"` left `"orld"` fully present in
the extracted text afterward). **Draw redaction boxes generously; a
too-tight box leaks the uncovered fragment of whatever it was meant to
remove.** An empty `areas` array is refused with `400 E_INVALID_FIELD`
rather than treated as a harmless no-op — there is no reason to call this
endpoint with nothing to redact.

### POST /pdf/edit

The general-purpose sibling of `/pdf/sign`: draws text, images, rectangles,
ellipses, lines and freehand strokes onto a PDF at caller-given positions,
instead of one of six fixed signature-shaped marks.

| Endpoint | Input | Output |
|---|---|---|
| `POST /pdf/edit` | One PDF (`file`), a JSON array of marks (`elements`), zero or more PNG/JPG images (`images`) | The PDF with every element drawn onto its page |

```bash
curl -F "file=@report.pdf" \
     -F 'elements=[{"type":"text","page":1,"x":72,"y":700,"value":"Approved","fontSize":14,"color":"red"},{"type":"rectangle","page":1,"x":72,"y":600,"width":150,"height":30,"color":"blue"}]' \
     https://converterapi.example.com/pdf/edit -o report-annotated.pdf
```

Every position is **top-left origin**, in points — the same convention
`/pdf/sign` and `/pdf/redact` already use — flipped to `pdf-lib`'s
bottom-left origin internally. Each element's shape depends on its `type`,
since a general editor's marks do not share one geometry the way `/pdf/sign`'s
fixed box does:

| `type` | Required fields | Optional fields |
|---|---|---|
| `text` | `x`, `y`, `value` | `fontSize` (default `14`), `color` |
| `image` | `x`, `y`, `width`, `height`, `imageIndex` | — |
| `rectangle` / `ellipse` | `x`, `y`, `width`, `height` | `color`, `strokeWidth` (default `2`), `fill` (default `false`) |
| `line` | `x1`, `y1`, `x2`, `y2` | `color`, `strokeWidth` |
| `freehand` | `points` (≥2 `{x, y}`, in order) | `color`, `strokeWidth` |

`imageIndex` is a 0-based index into the `images` files uploaded alongside
`file`, the same as `/pdf/sign`'s `images` (PNG/JPG only). `freehand` draws a
polyline through every point in `points` — a piecewise-straight
approximation of the stroke rather than a fitted curve, which is close
enough for anything sampled from mouse/touch movement at a reasonable rate
and needs no curve-fitting step `pdf-lib` has no built-in support for.

**This is a visual mark only, permanently baked into the page content — not
an editable annotation layer and not a cryptographic signature**, exactly
the same caveat `/pdf/sign` carries. There is no "move this text box later"
after the request completes; the caller decides final positions client-side
before sending them here.

### GET /formats

The [conversion matrix](#conversion-matrix) as JSON — every accepted extension,
and every target each one can become.

```bash
curl -sS https://converterapi.example.com/formats | jq '.sources[] | select(.extension==".docx")'
```

It exists so a client does not have to hard-code the table. The Android client
is a shipped **APK**, so without this, teaching it a new output format would
mean shipping a new APK; the web app could in principle redeploy on every
change, but reading the matrix from here means it does not have to either. A
client that hard-codes the matrix will silently disagree with the server the
first time the server grows.

### GET /health

Returns `200 {"status":"ok"}`. The service only starts listening after
LibreOffice, the rasteriser, the fonts and the PDF engine's Python
dependencies have been confirmed **and one real conversion has succeeded for
every document family** — so reaching this endpoint at all means the whole
matrix is ready, not merely that the process is up.

### Error reference

| Status | Code | Message (shown verbatim to the user) |
|---|---|---|
| `200` | — | *(the converted file)* |
| `500` | `E_CONVERT_FAILED` | This document could not be converted. It may be damaged or in a format the converter does not support. |
| `504` | `E_TIMEOUT` | This document took too long to convert. |
| `422` | `E_ENCRYPTED` | This document is password protected. |
| `422` | `E_NO_TABLES` | This document does not contain any tables. |
| `422` | `E_NO_LAYERS` | This PSD file does not contain any layers with images that can be extracted. |
| `415` | `E_UNSUPPORTED` | This file type cannot be converted. Supported types: .docx, .docm, .doc, … |
| `415` | `E_UNSUPPORTED_TARGET` | A .docx file can be converted to: PDF, ODT, TXT, HTML, RTF, EPUB, XLSX (tables). |
| `404` | `E_UNKNOWN_TARGET` | That is not a format this converter can produce. Available: PDF, ODT, DOCX, … |
| `413` | `E_TOO_LARGE` | This document is too large to convert. |
| `503` | `E_BUSY` | The converter is busy. Try again in a moment. |
| `400` | `E_BAD_REQUEST` | The document could not be received. Please try again. |
| `400` | `E_BAD_PAGE_RANGE` | *(the specific problem, e.g. "Page 9 does not exist in this 5-page document.")* |
| `400` | `E_TOO_FEW_FILES` | *(e.g. "Merging needs at least two PDF files.")* |
| `400` | `E_INVALID_FIELD` | *(e.g. "The \"degrees\" field must be a multiple of 90.")* |
| `422` | `E_WRONG_PASSWORD` | That password does not unlock this PDF. |
| `429` | `E_RATE_LIMITED` | Too many requests. Try again in a moment. |
| `500` | `E_INTERNAL` | Something went wrong on the server. |
| `404` | `E_BAD_REQUEST` | The converter is not available at this address. Please update the app and try again. *(also what a client on the removed bare `/convert` now receives)* |

The three `E_...` messages that end in a list are long on purpose. They are the
only place a client can discover the matrix from an error, and a person told
"that conversion is not supported" needs to know what is.

Most of these are additions, not part of the original contract: a request with
no file part, a per-IP rate limit, and an unrecognised path. They are additive
and cannot break a shipped client, which falls back to `HTTP <status>` for
anything it does not recognise.

`E_UNSUPPORTED_TARGET` and `E_UNKNOWN_TARGET` are new with the matrix. They can
only be reached by asking for a format, which the original client never did.

### Wire-compatibility constraints

A shipped Android client depends on each of these, and they are not style
choices. The web app is a second consumer of the same contract — it reads the
JSON error envelope and the status-before-body rule the same way (1-3 below)
— but it is not the reason these were frozen, and it carries no separate
abort timer or media-type check of its own worth pinning here (4-5 are
Android-specific numbers, not a promise made to the web app).

> **Breaking change: the bare `/convert` path was removed.** The target segment
> is now required, so a client built against `/convert` receives a `404`. Its
> message — *"The converter is not available at this address. Please update the
> app and try again."* — is the correct thing to show, but it is still a
> **broken client** until that client is updated to post to `/convert/pdf`.
> Nothing else in the list below changed.

1. **Success is `Content-Type: application/pdf` for a `pdf` target.** The client
   checks it and refuses anything else, so a stray `text/html` on a `200` is a
   client-visible failure.
2. **A non-2xx carries the JSON envelope.** The client reads `error.message` for
   its dialog and falls back to `"HTTP <status>"` when it is absent or not JSON.
   Express's and multer's default HTML error pages violate this, so every error
   path is funnelled through one handler.
3. **A failure is never a `200` with an error body.** The client checks the
   status *before* it reads anything, so a `200` is treated as a PDF and fails
   much further downstream.
4. **The server's deadline (90s) is shorter than the client's abort (120s)**, so
   the server can still answer with a proper error instead of being killed
   mid-conversion.
5. **The 100 MB body limit agrees with the client's `MAX_UPLOAD_BYTES`.** It is a
   named constant in [`src/config.ts`](src/config.ts), not a literal, and it is
   mirrored by the reverse proxy so an oversized upload is refused before it
   reaches Node. Express's default overflow response is an HTML page; that is
   overridden to return the envelope too.

---

## API documentation (OpenAPI)

The contract is described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1) and
served by the running service:

| Path | Returns |
|---|---|
| `GET /openapi.json` | The document as JSON |
| `GET /openapi.yaml` | The raw file, comments and all |
| `GET /docs` | Swagger UI, reading `/openapi.json` |

```bash
curl -sS localhost:3001/openapi.json | jq '.paths | keys'
open http://localhost:3001/docs
```

The document covers every status the service can return, each with the **exact
sentence the user will see** — so it doubles as the source for both clients'
dialog copy. It describes every endpoint either client uses — the original
`/convert/{target}` and page-level PDF operations the Android app relies on,
plus the sign/redact/edit/compare/form-filling routes that only the web app
calls; the docs routes above are infrastructure and are deliberately not
self-described.

Set `ENABLE_DOCS=0` to turn all three off.

Swagger UI is loaded from jsdelivr **by the browser**, not by the container, so
this works despite the service having no network egress. `/docs` is served with
a restrictive `Content-Security-Policy` (`default-src 'none'`), relaxed only
enough for Swagger UI's own bootstrap to run.

### Keeping it honest

The obvious failure mode of a hand-written spec is drift — it describes a
service that no longer exists, and a client generated from it fails in ways the
document said were impossible. [`test/openapi.test.ts`](test/openapi.test.ts)
exists to prevent that, and it is not a formality. It checks:

- every error code the service can produce appears in the document's
  `ErrorCode` enum, **and** that every documented code is one some code path
  actually produces (both directions, so neither an added error nor a deleted
  one slips through);
- every example message in the document is byte-for-byte a message
  `src/errors.ts` produces — this is the assertion that protects the user-facing
  copy;
- the document's `TargetId` enum is exactly the set of targets
  [`src/formats.ts`](src/formats.ts) implements — a documented target the router
  does not know is a `404` on a format the docs promise, and a target the router
  knows but the docs omit is invisible to every client;
- the long enumeration messages (supported types, a source's possible targets)
  match the matrix, so adding a format to the table fails this test until the
  user-facing copy is updated with it;
- `x-max-upload-bytes` equals `MAX_UPLOAD_BYTES`;
- every response the endpoints *actually return* is one the document says is
  possible, checked by exercising them against real conversions.

So: **change a message in `src/errors.ts` and `openapi.yaml` in the same
commit.** If you do not, the build fails and tells you which one is wrong.

---

## Fonts, and why they are not optional

**This is the requirement most likely to be skipped, because skipping it
produces no error at all.**

Calibri and Cambria are Microsoft fonts. They do not exist on Linux. When
LibreOffice is asked to lay out a document that uses them, it substitutes
whatever fontconfig offers — and the substitute has **different glyph widths**.

The document still converts. The PDF still opens. It looks correct. But every
line breaks in a slightly different place, so the page breaks land differently
than they do in Word. A three-page letter becomes four pages. A table spills
onto a second page. Nobody notices until a customer does.

The fix is metric-compatible substitutes — fonts that are *not* the Microsoft
originals but have been built to the same metrics, so text occupies the same
space and the layout is identical:

| Word asks for | Resolved to | Package |
|---|---|---|
| Calibri | **Carlito** | `fonts-crosextra-carlito` |
| Cambria | **Caladea** | `fonts-crosextra-caladea` |
| Arial | **Liberation Sans** | `fonts-liberation` |
| Times New Roman | **Liberation Serif** | `fonts-liberation` |
| Courier New | **Liberation Mono** | `fonts-liberation` |

### Why not `ttf-mscorefonts-installer`?

It ships the genuine Microsoft fonts, but it requires **interactive EULA
acceptance** during install, which breaks unattended image builds — exactly the
kind of thing that works on your machine and hangs in CI. It is also a
redistribution of fonts whose licensing is not designed for container images.
The metric-compatible set above is a drop-in replacement for the property that
actually matters here, which is *the metrics*, not the letterforms.

### The startup check

Because both failure modes are silent, the service checks for them at boot and
**refuses to start** if they are not satisfied:

```
Refusing to start: the metric-compatible font set is not installed.

  Calibri          resolved to "Noto Sans", expected Carlito  (fonts-crosextra-carlito)
  Cambria          resolved to "Noto Serif", expected Caladea  (fonts-crosextra-caladea)
...
```

It uses `fc-match`, which resolves the fontconfig alias chain — so a correct
answer proves **both** that the font is installed **and** that the alias exists,
which are the two conditions that have to hold together. A missing `soffice`
binary is refused the same way.

After preflight, the service performs one **warm-up conversion** of a small
built-in document. Preflight proves LibreOffice runs and the fonts resolve; it
does not prove the two work together to produce a PDF. The warm-up does, and it
also pays the one-off cost of first-run profile creation at boot rather than
inside some unlucky user's first request.

To verify by hand:

```bash
fc-match Calibri     # want: Carlito
fc-match Cambria     # want: Caladea
```

---

## How conversion works

LibreOffice is invoked as a subprocess, once per request:

```
soffice --headless --norestore --invisible --nolockcheck --nodefault --nofirststartwizard \
  -env:UserInstallation=file:///<tmpdir>/lo-profile \
  --convert-to pdf:writer_pdf_Export --outdir <tmpdir> <input>
```

That is the whole of the conversion for a `direct` target. The others do
something else, and each is described in its own section: `png`/`jpg` render to
PDF first and then rasterise it, because LibreOffice's command-line image export
only ever writes the first page ([Image
targets](#image-targets-and-why-they-need-poppler)) — except from a PDF
source, which skips straight to the rasterise step, since the upload already
is the PDF; `tables` and `layers` do not call LibreOffice at all, reading the
document themselves instead ([Extracting tables](#extracting-tables),
[Extracting PSD layers](#extracting-psd-layers)); and a PDF asking for
`docx`/`pptx`/`xlsx` calls a second, unrelated engine —
[`scripts/pdf_engine.py`](scripts/pdf_engine.py) — because LibreOffice cannot
produce any of those three from a PDF at all ([PDF as a
source](#pdf-as-a-source-and-why-some-of-its-targets-are-not-libreoffice-either)).

The `--convert-to` argument is `<extension>:<filter>`, and both halves come from
the matrix in [`src/formats.ts`](src/formats.ts). Filters are named after the
**document family**, not the file type, which is why the same request looks
different depending on the source: PDF is `writer_pdf_Export` from Writer,
`calc_pdf_Export` from Calc, `impress_pdf_Export` from Impress and
`draw_pdf_Export` from Draw. Some targets also need filter options — CSV export
takes nine positional options for separator, encoding and quoting, and plain
text takes an explicit `UTF8`, without which non-ASCII becomes question marks
while the conversion still reports success.

No npm library is involved. No library paginates `.docx` correctly — that is a
layout engine, not a file-format problem — and routing through HTML (Puppeteer
or similar) moves the fidelity problem to the server instead of solving it.

### The two things that are easy to get wrong

**1. A per-request LibreOffice profile.** Every invocation needs its own
`-env:UserInstallation`. Without it, concurrent `soffice` processes collide over
the shared profile directory and conversions fail or hang *intermittently* —
which is the single most common cause of "works on my machine" in a service
like this. Each request gets its own profile directory inside its own temp dir.

**2. The metric-compatible fonts.** Covered [above](#fonts-and-why-they-are-not-optional).

### Details that matter

- **The client's filename never touches the filesystem.** The upload is written
  to a server-generated `input.<validated extension>` inside a per-request temp
  dir. The original name is read only to derive the extension. A filename like
  `../../etc/cron.d/x.docx` is a path traversal waiting to happen and there is
  no reason to take the risk.
- **`HOME` and `TMPDIR` are pointed at the request's temp dir**, so nothing
  writes into a real home directory.
- **Never runs as root.** The service refuses to boot as `uid 0`, since the
  document parser is the entire attack surface and running it as root turns any
  bug in it into a total compromise.
- **On timeout: SIGTERM, then SIGKILL** after a 5s grace period. Both target the
  whole *process group*, so helpers LibreOffice forked are not left holding the
  CPU.
- **The exit code is not trusted.** `--convert-to` **exits 0 even when it
  fails** — a corrupt document prints `Error: source file could not be loaded`
  and still returns status 0. The only trustworthy signal is whether a non-empty
  file of the expected type appeared in the output directory, so that is what is
  checked — by extension, and by magic bytes for PDF, PNG and JPEG.
- **One deadline covers the whole pipeline**, not each process. A PNG request
  runs two subprocesses, and what is being rationed is the client's patience,
  not any one process's runtime.

### Password-protected documents

Encrypted documents are detected *before* LibreOffice runs, because LibreOffice
reports an encrypted document exactly the way it reports a corrupt one — and
telling a user their file is damaged when it merely needs a password is both
wrong and unhelpful.

ECMA-376 encryption wraps the package in an OLE/CFB container holding an
`EncryptedPackage` stream, so an encrypted `.docx` stops being a ZIP. Legacy
`.doc` files are CFB either way and set `fEncrypted` (or `fObfuscated`) in the
FIB. Both are checked by a small CFB reader in
[`src/lib/encrypted.ts`](src/lib/encrypted.ts). It is best-effort by design:
anything it cannot parse confidently falls through to LibreOffice, because a
false negative costs a less specific error message while a false positive would
reject a document that could have been converted.

A PDF is checked too, since an encrypted PDF would otherwise reach
`pdf_engine.py` (or soffice, for `pdfa`/`png`/`jpg`) and come back as the same
generic failure. Per the PDF spec, an encrypted file's `/Encrypt` key must be
in the trailer of its LAST update, so the detector follows the file's final
`startxref` to that trailer (or, in a PDF 1.5+ file with no `xref`/`trailer`
keywords at all, to the cross-reference stream object that serves as one) and
looks for `/Encrypt` only there. This is deliberately **not** a blind
whole-file search for the token, which is what an earlier version did and
which has a real false-positive mode: a PDF that was ever encrypted and later
re-saved without a password keeps its earlier revision's bytes - `/Encrypt`
entry included - physically in the file, even though that revision no longer
governs anything. A blind search finds the stale entry and rejects a document
that opens and converts perfectly well; following the actual current trailer
does not.

It covers the OOXML, Word binary and PDF formats. An encrypted ODF file is
left to LibreOffice, which reports it the same way it reports a damaged file —
acceptable, because that is not a format this service reaches through
LibreOffice for anything that would otherwise give a worse error.

---

## Image targets, and why they need poppler

`png` and `jpg` are the only targets produced by two processes, and the reason
is a LibreOffice limitation that is worth writing down because it looks like a
bug in *this* service.

The obvious implementation is one command:

```bash
soffice --convert-to png:impress_png_Export --outdir out deck.pptx
```

**It exports the first slide and stops.** Not one image per slide — one image,
period. The `PageRange` filter option that is supposed to control this is
accepted and ignored, and it is genuinely ignored rather than misspelled:
passing `PixelWidth` through the same JSON option mechanism changes the output
resolution, which proves the options are being parsed at all. This is a
long-standing limitation of the command-line image export, not something a
better filter name fixes.

So the pipeline renders the deck to PDF first and rasterises that:

```bash
soffice --convert-to pdf:impress_pdf_Export --outdir out deck.pptx
pdftoppm -png -r 150 out/deck.pdf out/slide     # slide-1.png, slide-2.png, …
```

`pdftoppm` (Debian package `poppler-utils`) numbers the pages itself, and the
service re-sorts them numerically before naming them, so `slide-2` cannot end up
after `slide-10` if poppler's zero-padding ever changes.

Two consequences worth knowing:

- **poppler is a hard dependency**, checked at boot like everything else. A
  container without it would otherwise start happily and fail the first image
  request with an error that reads like a problem with the user's file.
- **The archive is built in memory**, so `MAX_RASTER_PAGES` (default 100) bounds
  how many pages will be rasterised at once. Past it the request is refused with
  `E_TOO_LARGE` rather than OOM-killing the container mid-response.

---

## Extracting tables

`POST /convert/tables` on a `.docx` or `.docm` returns an `.xlsx` workbook with
one worksheet per table in the document. This is the only target that involves
**no LibreOffice at all**, and it is the only one whose answer is read out of
the document rather than converted from it.

A `.docx` is a ZIP of XML parts, so the work is: read `word/document.xml` out of
that ZIP, walk it for `w:tbl` elements, and write a workbook. Both halves are in
this repository, with no dependencies beyond Node's own `zlib`:

| Module | What it does |
|---|---|
| [`src/lib/unzip.ts`](src/lib/unzip.ts) | Reads one named entry out of a ZIP |
| [`src/lib/docx-tables.ts`](src/lib/docx-tables.ts) | Walks the XML for tables |
| [`src/lib/xlsx.ts`](src/lib/xlsx.ts) | Writes the workbook |
| [`src/lib/xml-text.ts`](src/lib/xml-text.ts) | Decodes entities in cell text |

The reason it is written rather than depended on is the same reason
[`src/lib/zip.ts`](src/lib/zip.ts) and [`src/lib/encrypted.ts`](src/lib/encrypted.ts)
are: a format that can be described in a few hundred lines does not justify a
package, and the reader here is deliberately narrow — it resolves one name to
bytes and never to a path, which is what makes zip-slip a non-issue rather than
something to sanitise carefully.

### Merged cells

The part that is actually hard, and the part most implementations get wrong. The
extractor expands merges so the grid matches what a person sees in Word:

- **`w:gridSpan`** — one cell occupying N columns. It occupies them *all*, so
  every later cell in the row shifts right. Getting this wrong misaligns the
  rest of the row rather than just the merged cell.
- **`w:vMerge`** — a cell continuing the cell above it. The continuing cells are
  usually **empty in the XML**: the value only exists in the cell that restarts
  the merge, so it has to be carried down. The carry is tracked per *column*,
  because the cells of a merged run are not adjacent in the XML.

A merged cell's value is repeated across every position it covers. The cost is
that it appears more than once in the workbook, which is the right default: the
alternative is a grid with holes in it, and a hole in a spreadsheet is
indistinguishable from a cell nobody filled in.

### What it does not do

- **Tables in headers, footers and footnotes are not found.** Only
  `word/document.xml` is read, which is where the body's tables live. Reading
  every part would mean building a document model, which is the thing this
  deliberately is not.
- **The `w:` prefix is assumed.** Every OOXML producer emits it — Word,
  LibreOffice, and every library that generates `.docx` — because the format's
  own examples and test suites use it. A document binding the namespace to some
  other prefix reads as having no tables, which is a wrong answer rather than a
  crash.
- **`.doc` is not supported.** Same family, same audience, binary container.

### Bounds

Two limits, and they exist because the workbook is assembled in memory — the
same reasoning as `MAX_RASTER_PAGES`:

- `MAX_DOCUMENT_XML_BYTES` (default 32MB) caps the inflated size of
  `word/document.xml`, checked against the size the archive's own directory
  declares **before** any inflating happens. The upload is capped at 100MB, but
  that much DEFLATE can inflate to gigabytes, and the only place to stop a
  decompression bomb is before the work.
  A second check uses the inflate's own output cap, which is what catches a
  directory that lied.
- `MAX_TABLE_CELLS` (default 200,000) caps the grid positions one document may
  contribute. Cells and rows each count one, because a row is retained in
  memory whether or not anything is in it. This is deliberately a bound on
  positions rather than bytes: a merged cell is counted once per column it
  covers, so a document can cost far more than its own text suggests.
- `MAX_TABLES` (default 1,000) caps how many tables a document may hold, and is
  **not** redundant next to the cell count. The extractor retains a frame per
  table while it scans — tables are only ordered and filtered once the scan is
  over — so a document of nothing but empty tables costs memory per table and no
  cells at all. Measured: 14MB of empty tables grew the heap by 305MB while
  reporting a clean extraction of zero tables; with the bound it is refused in
  5ms and 15MB.

Past any of these limits the request is refused with `E_TOO_LARGE`.

### Why this one does not run in a subprocess

Every other pipeline spawns a child process, so a slow conversion never occupies
the event loop. This one runs in-process, and that is a deliberate trade: the
scan is synchronous once the XML is in hand, so it cannot be interrupted
halfway, and a deadline would only ever be consulted after the work it was meant
to bound. The bounds above are what keep it honest instead.

In practice this is not close to mattering — a document at the cell limit is a
fraction of a second, against the ~130ms *floor* of a soffice conversion. The
boot check converts a table-bearing document through this pipeline so a fault in
it fails startup rather than someone's upload.

### The failure case that is not a failure

A document with no tables is a **`422 E_NO_TABLES`**, not a `500`. The document
opened and was read; it simply has nothing to extract. Reporting it as a
conversion failure would tell the user their file may be damaged when the truth
is that it is a perfectly good document with no tables in it.

A `.docx` that is not really a `.docx` — corrupt, truncated, or renamed from
something else — is the opposite case and *is* a `500 E_CONVERT_FAILED`, because
there is nothing to say about tables until the document they would be in can be
read at all.

---

## Extracting PSD layers

`POST /convert/layers` on a `.psd` returns a ZIP holding **one PNG per layer**,
with the document's group structure preserved as directories, plus a
`manifest.json` describing every layer.

```
design.zip
├── Background.png
├── Buttons/
│   ├── Normal.png
│   └── Hover.png
└── manifest.json
```

Each image is the layer's **own bounding box**, not the whole canvas — smaller,
and it is what the layer actually draws. That is why the manifest carries every
layer's `left`/`top`/`right`/`bottom`: those offsets are the only way to put the
document back together, so a client that wants a single flattened image has
everything it needs and one that wants the pieces is not paying for transparent
padding around each one.

| File | What it is |
|---|---|
| [`src/lib/psd-layers.ts`](src/lib/psd-layers.ts) | Bounds pass, layer walk, manifest |
| [`src/lib/png.ts`](src/lib/png.ts) | The PNG writer |
| [`src/lib/psd.ts`](src/lib/psd.ts) | The one place ag-psd is configured |

### No `canvas`, and no native dependency

The obvious way to read a PSD in Node is `ag-psd` plus `node-canvas`, and the
usual write-up says `canvas` is a hard requirement. It is not. ag-psd calls into
the canvas factory in exactly one place on the read path — `createImageData` for
8-bit RGBA pixels — and that is a plain object with a `Uint8ClampedArray` in it.
Registering a `createCanvas` that throws, and a `createImageData` that is three
lines of arithmetic, is a complete substitute.

This matters more than it sounds. `node-canvas` is a native module: it needs
cairo and pango in the runtime image and a compiler in the build image, and it
has to be rebuilt for every Node major. Reading with `useImageData` also avoids
a correctness trap — a canvas stores colour *premultiplied* by alpha, so
round-tripping pixel data through one quietly corrupts every semi-transparent
pixel, which ag-psd's own documentation gives as the reason to prefer the
`imageData` path.

So `ag-psd` is a pure-JavaScript dependency (its only dependencies are
`base64-js` and `pako`) and **the Dockerfile is unchanged** by this feature. The
PNG writer is hand-rolled for the same reason [`src/lib/zip.ts`](src/lib/zip.ts)
and [`src/lib/xlsx.ts`](src/lib/xlsx.ts) are: the case is narrow — 8-bit or
16-bit RGBA, non-interlaced, no ancillary chunks — and the failure mode of a
too-clever image encoder is a file that opens and is subtly wrong.

### The bounds pass, and why it comes first

This is the part worth reading before changing anything.

A PSD declares the byte length of every layer channel **in its own header**, and
a reader allocates what is declared. ag-psd's byte reader, finding a declared
length that runs past the end of the file, warns and then allocates
`new Uint8Array(length)` anyway — up to a 100MB ceiling — and holds that buffer
per channel until the layer is decoded, which happens only after *every* layer
record has been read. Layer count and channel length are both read straight from
the file with no comparison against the file's actual size.

A few hundred kilobytes of carefully arranged PSD can therefore ask for
terabytes before any pixel data is looked at. On a container with
`mem_limit: 1g` that is an OOM kill of the whole service, and an OOM kill
reaches the user as a network error rather than as a sentence about their file.

So `readDeclaredSizes` walks the header and the layer records reading **nothing
but lengths**, allocating nothing, and refuses the moment the declared total
passes `MAX_PSD_DECODE_BYTES`. It works on the same principle as the check in
[`src/lib/unzip.ts`](src/lib/unzip.ts): stop a decompression bomb before the
inflate, using the sizes the container declares about itself.

The walk is also checked against the file. After the last record comes every
channel's pixel data, and that occupies exactly the bytes the channel lengths
declared — so the records plus the declared total have to land on the end of the
layer section, up to the few bytes of alignment a writer applies. Inflating a
channel length to force a large allocation cannot survive that, because the
bytes it claims are not in the file. Measured: a **502-byte** document declaring
a 90MB channel is refused in under a millisecond, having allocated nothing.

Anything that does not walk cleanly is refused as unreadable rather than guessed
at, because guessing is how a bounds check stops bounding anything.

### What it does not do

- **No layer styles, masks, opacity or blend modes are applied.** The image is
  the layer's pixels as the document stores them, not as Photoshop composites
  them. A layer using a mask or a non-normal blend mode will not look like what
  you see on screen, and the manifest records `hidden` and `opacity` so a client
  can tell that the situation arose at all.
- **Hidden layers are exported**, and flagged `hidden: true`. Dropping them
  would make the archive's layer count disagree with the document's with nothing
  anywhere to explain why, and hidden layers are usually alternates a designer
  wants back.
- **No 32-bit-per-channel (HDR) layers.** PNG has no floating-point form and
  there is no honest 8-bit answer to what a linear HDR pixel is in sRGB, so
  those layers are skipped and recorded rather than squeezed. 16-bit *is*
  written, at 16 bits, because PNG carries it natively.
- **No group images.** A group has no pixels of its own; its name becomes a
  directory.
- **No `.psb`.** A large-document file renamed to `.psd` is refused by name
  rather than mis-parsed.

### The failure cases

A PSD that opens but holds nothing drawable — an adjustment-only document, or
one whose layers are all 32-bit — is a **`422 E_NO_LAYERS`**, the twin of
`E_NO_TABLES` and for the same reason: the file is exactly what it claims to be,
and it is not damaged. A file that is not a PSD at all is a
`500 E_CONVERT_FAILED`, because there is nothing to say about a document's
layers until the document can be read.

Anything past a limit is a `413 E_TOO_LARGE`: more than `MAX_PSD_LAYERS`
layers, more than `MAX_PSD_DECODE_BYTES` of declared pixel data, or more than
`MAX_LAYER_OUTPUT_BYTES` of finished PNG.

---

## Concurrency model

`soffice` converts one document per process and is CPU- and memory-heavy, so the
useful thing to bound is not "how many requests arrive" but "how many
conversions run at once". Past that bound, extra work does not go faster — it
makes every request slower and eventually pushes all of them past the client's
120s abort, which turns a busy server into a server that looks broken.

So [`src/lib/queue.ts`](src/lib/queue.ts) implements a bounded queue:

- **2 conversions run concurrently by default** (`MAX_CONCURRENT_CONVERSIONS`).
- **8 may wait** (`MAX_QUEUED_CONVERSIONS`).
- **Beyond that: `503 E_BUSY`, immediately.** A prompt "try again in a moment" is
  a far better answer than a request that hangs for two minutes and then dies.

The queue is checked *before* the body is read, so a client is told the
converter is busy rather than spending a minute uploading 100 MB to find out. A
request whose client disconnects while it is still queued is removed from the
queue rather than being handed a slot nobody wants.

Resource limits belong on the container, not in Node: see
[Operational limits](#operational-limits).

---

## Cleanup and temp files

Each request gets its own temp directory holding the input, that request's
LibreOffice profile, and the output. It is deleted on **every** path:

- **success** — before the response is written, so the space is reclaimed the
  moment the client has its file;
- **conversion failure, timeout, bad request** — in the error handler, also
  before the response;
- **client disconnect** — the running `soffice` is killed and the workspace
  removed;
- **paths that never reach the handler** (multer rejecting an oversized or
  wrong-extension upload) — via a `res.on('close')` net, which runs on every
  request without exception.

Three layers, because the failure mode they prevent — a disk that slowly fills
until the service dies — is invisible until it is fatal.

> **A note on `req.on('close')`.** Listening for that event alone is a common
> and wrong way to detect a client disconnect: it also fires the moment the
> request body has been *fully read*, which for a small upload is before the
> conversion has even started. Used naively it aborts every successful request.
> This service guards it with `req.complete` (the body was still arriving when
> the socket died) and pairs it with `res.on('close')` +
> `!res.writableFinished`, which is the general case.

**Stale workspaces** left by a crash are swept on startup and every 5 minutes.
Only directories older than 15 minutes are touched, which is comfortably longer
than the 90s conversion deadline, so a slow-but-alive conversion is never swept
out from under itself. The age is re-checked immediately before each delete, so
a workspace touched between the check and the delete is left alone.

---

## Operational limits

| Limit | Value | Where |
|---|---|---|
| Max upload | 100 MB | `MAX_UPLOAD_BYTES` (must equal the client's) + proxy `client_max_body_size`, and dead-ceiling-capped by Cloudflare's own 100MB edge limit |
| Files per page operation | 20 | `MAX_PAGE_OPERATION_FILES` (`/pdf/merge`, `/pdf/scan-to-pdf`) |
| Combined size per page operation | 100 MB | `MAX_PAGE_OPERATION_TOTAL_BYTES` (several files, not one) |
| Conversion deadline | 90s | `CONVERT_TIMEOUT_MS` (client aborts at 120s) |
| SIGKILL grace | 5s | `SIGKILL_GRACE_MS` |
| Concurrent conversions | 2 | `MAX_CONCURRENT_CONVERSIONS` |
| Queued conversions | 8 | `MAX_QUEUED_CONVERSIONS` |
| Requests per IP | 30 / min | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Pages per image export | 100 | `MAX_RASTER_PAGES` (the archive is built in memory) |
| Table cells per document | 200,000 | `MAX_TABLE_CELLS` (the workbook is built in memory) |
| Tables per document | 1,000 | `MAX_TABLES` (a frame is held per table during the scan) |
| Inflated `word/document.xml` | 32 MB | `MAX_DOCUMENT_XML_BYTES` (the decompression-bomb bound) |
| Layers per PSD | 500 | `MAX_PSD_LAYERS` (a record is held per layer) |
| Declared PSD pixel data | 192 MB | `MAX_PSD_DECODE_BYTES` (the decompression-bomb bound) |
| PSD image output | 48 MB | `MAX_LAYER_OUTPUT_BYTES` (the archive is built in memory) |
| Image resolution | 150 DPI | `RASTER_DPI` |
| JPEG quality | 90 | `RASTER_JPEG_QUALITY` |
| Stale sweep | every 5 min | `SWEEP_INTERVAL_MS` |
| Stale age | 15 min | `STALE_WORKSPACE_MS` |
| Container memory | 3 GB | `docker-compose.yml` (`mem_limit`/`memswap_limit`, raised from 1g/1g for `/media/{target}`) |
| Container CPUs | 2 | `docker-compose.yml` |
| Container PIDs | 256 | `docker-compose.yml` |
| tmpfs for workspaces | 2 GB | `docker-compose.yml` |

**Sizing note.** `MAX_CONCURRENT_CONVERSIONS × typical soffice memory` must stay
under the container's `mem_limit`, or the kernel OOM-kills `soffice` mid-run and
every request becomes a `500`. LibreOffice peaks in the low hundreds of MB for
ordinary documents and considerably more for image-heavy ones; 2 concurrent
under a 3 GB cap is a deliberately conservative starting point that also leaves
room for a 100MB `/media/{target}` upload and its transcode. Raise both
together, not one.

**Logging.** One JSON line per request: request id, outcome, source extension,
target, status, code, byte size and duration. **Document contents and filenames
are never logged** — the extension and target say what the person asked for
without saying what they asked it about. The `X-Request-Id` response header ties
a client report to a server log line.

---

## Configuration

All configuration is environment variables read in
[`src/config.ts`](src/config.ts).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `TEMP_ROOT` | `$TMPDIR/converterapi` | Must be writable; should be a tmpfs |
| `SOFFICE_BIN` | `soffice` | If not on `PATH` |
| `PDFTOPPM_BIN` | `pdftoppm` | If not on `PATH`; needed by the PNG/JPG targets |
| `QPDF_BIN` | `qpdf` | If not on `PATH`; needed by `/pdf/protect` and `/pdf/unlock` |
| `PANDOC_BIN` | `pandoc` | If not on `PATH`; needed by the markup sources (`.md`/`.rst`/...) |
| `SEVENZIP_BIN` | `7z` | If not on `PATH`; needed by the archive sources/targets |
| `FFMPEG_BIN` | `ffmpeg` | If not on `PATH`; needed by the image-transcode targets and `/media/{target}` |
| `TESSERACT_BIN` | `tesseract` | If not on `PATH`; OCR for a scanned PDF's `docx` - missing is a boot warning, not a refusal |
| `OCR_LANGUAGES` | `eng+aze+tur+rus` | `+`-joined tesseract language codes; must match the installed `tesseract-ocr-<lang>` packages |
| `RASTER_DPI` | `150` | Resolution of a rasterised page |
| `RASTER_JPEG_QUALITY` | `90` | For the `jpg` target |
| `MAX_RASTER_PAGES` | `100` | Refused with `E_TOO_LARGE` beyond this |
| `MAX_TABLE_CELLS` | `200000` | For the `tables` target; refused with `E_TOO_LARGE` |
| `MAX_TABLES` | `1000` | For the `tables` target; refused with `E_TOO_LARGE` |
| `MAX_DOCUMENT_XML_BYTES` | `33554432` | Caps the inflated `word/document.xml` |
| `MAX_PSD_LAYERS` | `500` | For the `layers` target; refused with `E_TOO_LARGE` |
| `MAX_PSD_DECODE_BYTES` | `201326592` | For the `layers` target; the pixel data a PSD may declare |
| `MAX_LAYER_OUTPUT_BYTES` | `50331648` | For the `layers` target; refused with `E_TOO_LARGE` |
| `MAX_PAGE_OPERATION_FILES` | `20` | For `/pdf/merge`, `/pdf/scan-to-pdf`; refused with `E_TOO_LARGE` |
| `MAX_PAGE_OPERATION_TOTAL_BYTES` | `104857600` | Combined size of every file in one page-operation request |
| `MAX_CONVERT_FILES` | `15` | For `/convert/{target}`; refused with `E_TOO_LARGE` |
| `MAX_CONVERT_TOTAL_BYTES` | `104857600` | Combined size of every file in one `/convert/{target}` request (several files, not one) |
| `MAX_UPLOAD_BYTES` | `104857600` (100MB) | `/convert/{target}`'s per-file cap - must equal the Android client's own, and the reverse proxy's body-size limit; see [Wire-compatibility constraints](#wire-compatibility-constraints) |
| `MAX_ARCHIVE_ENTRIES` | `5000` | For the archive targets; refused with `E_CONVERT_FAILED` |
| `MAX_ARCHIVE_UNCOMPRESSED_BYTES` | `536870912` (512MB) | For the archive targets; the decompression-bomb bound |
| `MEDIA_MAX_UPLOAD_BYTES` | `104857600` (100MB) | `/media/{target}`'s own upload cap - defaults to the same value as `MAX_UPLOAD_BYTES`, since Cloudflare's own edge refuses any request body over 100MB regardless of what either constant allows |
| `MEDIA_CONVERT_TIMEOUT_MS` | `1800000` (30 min) | How long one media job may run before `E_TIMEOUT` |
| `MEDIA_JOB_TTL_MS` | `1800000` (30 min) | How long a finished media job's result stays downloadable |
| `MAX_CONCURRENT_MEDIA_JOBS` | `1` | Its own pool, separate from `MAX_CONCURRENT_CONVERSIONS` |
| `MAX_QUEUED_MEDIA_JOBS` | `4` | `0` disables queueing entirely |
| `MEDIA_TEMP_ROOT` | `$TMPDIR/converterapi-media` | A sibling of `TEMP_ROOT`, not nested under it - see the constant's own comment in `config.ts` |
| `MAX_CONCURRENT_CONVERSIONS` | `2` | |
| `MAX_QUEUED_CONVERSIONS` | `8` | `0` disables queueing entirely |
| `CONVERT_TIMEOUT_MS` | `90000` | Must stay below the client's 120s |
| `SIGKILL_GRACE_MS` | `5000` | |
| `STALE_WORKSPACE_MS` | `900000` | Must stay above `CONVERT_TIMEOUT_MS` |
| `SWEEP_INTERVAL_MS` | `300000` | |
| `RATE_LIMIT_MAX` | `30` | Per IP, per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `TRUST_PROXY` | `loopback` | `1` = one proxy hop; see below |
| `CORS_ORIGIN` | unset | The one browser origin allowed; see below |
| `SKIP_WARMUP` | unset | `1` skips the boot-time warm-up conversion |
| `ENABLE_DOCS` | on | `0` disables `/docs`, `/openapi.json`, `/openapi.yaml` |

`TRUST_PROXY` deserves care. `req.ip` is only the client's address if the
service believes the proxy's forwarding header. Behind a single reverse proxy
set it to `1` (one hop). Numeric values are passed to Express as numbers —
the string `"1"` would otherwise be read as the IP address `1`.

`CORS_ORIGIN` is set only when the frontend is served from a different hostname
than the API, which makes every call from the browser cross-origin. It must be
a bare origin — `https://converter.alakbaroff.com`, with no path and no
trailing slash — because a browser compares the string to the request's
`Origin` exactly, so anything else matches nothing and fails closed with a CORS
error that looks like the server being down. It throws at boot rather than
letting you discover that in a browser console. See
[`src/middleware/cors.ts`](src/middleware/cors.ts).

Two things that policy is **not**. It is not access control: CORS is a rule
browsers enforce on themselves, so the Android client — which sends no `Origin`
at all — is unaffected either way, and anything able to open a socket can
simply omit the header. What protects the endpoint is the rate limit. And it is
not complete from the application alone: nginx refuses an oversized upload with
its own 413 before Node sees a byte, so that one response carries its header in
the nginx site file instead.

---

## Security posture

Stated plainly, because the honest description is more useful than a reassuring
one.

**The attack surface is document parsing, and it is fully exposed.** This
endpoint parses untrusted documents from the public internet. LibreOffice is a
large C++ codebase with a long history of memory-safety bugs in exactly the
import filters this service exercises. **Treat a conversion failure as an
expected, normal event, not an incident** — and assume that a sufficiently
determined attacker can eventually find a way to run code inside the container.

The archive engine (`.zip`/`.tar`/... → `zip`/`tar`/...) additionally
**unpacks** untrusted bytes to disk, which nothing else in this service does —
see [Archive sources](#archive-sources-7z-and-why-unpacking-gets-extra-rules)
for the zip-slip, symlink and decompression-bomb mitigations that exist
specifically because of it.

The design assumption is therefore *not* "the parser is safe" but "the parser
will be compromised, and it should be worth very little":

- **Unprivileged.** Runs as uid 1000; refuses to boot as root.
- **No capabilities.** `cap_drop: ALL`, `no-new-privileges`.
- **Read-only root filesystem.** `/tmp` is the only writable path, and it is a
  size-capped tmpfs.
- **Seccomp.** Docker's default profile, tightened with additional denials for
  `ptrace`, `process_vm_readv/writev`, `userfaultfd`, `io_uring_*`, `bpf`,
  `perf_event_open`, kernel module and mount syscalls, and the kernel keyring —
  none of which a headless document converter needs. Generated reproducibly by
  [`deploy/make-seccomp.mjs`](deploy/make-seccomp.mjs) from the upstream default.
- **Loopback-only binding.** Published on `127.0.0.1` only, so the container is
  reachable by a proxy on this host and by nothing else — not the LAN, not the
  internet.
- **Memory and PID caps**, so a pathological document degrades one container
  rather than the host.
- **No network egress** — *given up by the default compose file, deliberately.*
  Publishing a port and an `internal: true` network are mutually exclusive, and
  a host-side proxy needs the port. See [Network
  egress](#network-egress) for the two ways to get the property back. The
  service itself is unchanged either way; this is a deployment choice.

**The endpoint is unauthenticated, and it cannot be otherwise.** The client is
an APK; any secret shipped inside it is public. There is no credential that
would not also be available to anyone who downloads the app. So instead of
pretending otherwise:

- **Rate-limit by IP** (30 requests/minute by default).
- **Cap concurrent jobs**, and shed load with `503` rather than queueing
  without bound.
- **Assume abuse.** The limits above are sized for that assumption.

**TLS terminates at a reverse proxy** in front of the service — the client uses
`https://` and the app speaks plain HTTP, bound to loopback. The proxy's body
limit is set to match the application's 100 MB so a large upload is rejected
before it reaches Node at all. Note that the proxy is also where you would add
anything stronger than per-IP limiting (a WAF, a proof-of-work challenge, an
allowlist) if this ever attracts real attention.

A word on `TRUST_PROXY`. The app believes `X-Forwarded-For` because your proxy
sets it, which is what makes per-IP rate limiting work at all. That trust is
only safe while the app is bound to loopback: if it were ever published on
`0.0.0.0`, a direct client could forge the header and give itself a fresh rate
limit bucket per request. The loopback binding and `TRUST_PROXY` are one
decision, not two.

**What is deliberately not logged:** document contents and filenames. Request
id, byte size, duration and outcome only. Documents uploaded here are the user's
private files and there is no operational reason to retain them.

**Known limitations, stated rather than glossed over:**

- Rate limiting is in-memory and per-process. Behind more than one replica it
  becomes per-replica, and it resets on restart. Move it to the proxy or a
  shared store if you scale out.
- The rate limiter is a fixed window, which allows a burst at a window boundary.
  Adequate for load shedding; not a defence against a determined attacker.
- A hostile document can still consume a full conversion slot for up to 90s.
  The concurrency cap bounds the damage but does not prevent it.
- **Accepting more formats means more parsers.** Every family in the matrix is a
  different LibreOffice import filter, and the import filters are where
  memory-safety bugs live. A converter that accepts sixteen extensions has a
  wider attack surface than one that accepts three, and that is the cost of the
  feature rather than something the design can offset. The mitigations above are
  what make it affordable.
- **HTML import can reference external resources.** A `.html` upload with
  `<img src="...">` makes LibreOffice resolve that reference while importing — a
  URL or a `file://` path. In this deployment the container has no network egress
  (see [Network egress](#network-egress)) and the only files it can read are the
  application's own code and the request's own workspace, so there is little to
  reach. It is noted because it is a real behaviour, not a theoretical one, and
  because a deployment that *does* grant egress changes the picture.

---

## Deployment

`docker-compose.yml` runs the **converter only**. It expects a reverse proxy in
front of it — nginx on the host — which terminates TLS and applies the matching
request body limit. There is deliberately no bundled proxy: see
[Why there is no bundled proxy](#why-there-is-no-bundled-proxy).

```bash
docker compose up -d --build
curl -sS http://localhost:3010/health      # {"status":"ok"}
```

### Continuous deployment

Pushing to `master` deploys. [`github/workflows/deploy.yml`](.github/workflows/deploy.yml)
SSHes into the server, pulls, rebuilds the `converterapi` service, and then polls
`/health` until it answers — because `docker compose up -d` reports success for
a container that is about to crashloop, and the health check is what tells the
two apart.

Setting the server up the first time is manual and is covered step by step in
[`deploy/SERVER-SETUP.md`](deploy/SERVER-SETUP.md): DNS, the one-time clone, the
first build watched by hand, and the nginx site — which reuses the existing
`*.alakbaroff.com` wildcard certificate rather than issuing a new one.

Both need three repo secrets: `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`.

The converter publishes on **loopback only** (`127.0.0.1:3010`), so it is
reachable by a proxy running on this host and by nothing else — not the LAN,
not the internet. Keep that prefix: dropping it would expose an unauthenticated
endpoint that parses untrusted documents to your whole network. Keep the port
too: 3000 and 3001 are what the other services on this host use.

### With nginx

[`deploy/converter.alakbaroff.com.conf`](deploy/converter.alakbaroff.com.conf)
is this deployment's actual site — both hostnames, the frontend and the API, in
one file. [`deploy/nginx.conf.example`](deploy/nginx.conf.example) is a generic
single-host block to adapt if you are deploying this somewhere else. The parts
that matter:

- `client_max_body_size 100m` — **must match `MAX_UPLOAD_BYTES`**, so an
  oversized upload is refused before it reaches Node. Two halves of one number.
- `proxy_read_timeout 120s` — the app's deadline is 90s and the client gives up
  at 120s; neither helps if nginx cuts the connection first.
- `error_page 413` rewritten into the JSON envelope, because the client reads
  its dialog text from `error.message` and would otherwise show a bare
  `HTTP 413`.

Point `proxy_pass` at `http://127.0.0.1:3010`.

### Why there is no bundled proxy

There used to be one — a Caddy service behind an opt-in profile — and it was
removed, because it could never be useful on a host that already terminates TLS.

Any proxy worth bundling has to bind ports 80 and 443, and this host already
runs nginx doing exactly that. So the bundled one could only fail to start or
fight the host for the ports, which is the failure the old comment here spent
three lines warning about — a warning that was really an argument against
shipping it. Its only purpose was a deployment with no reverse proxy at all,
and a generic nginx example serves that case without standing up a second TLS
stack inside the compose file, complete with its own volumes and network.

### Network egress

**This is a deliberate trade-off, and it is worth understanding.**

The converter parses untrusted documents, so the design assumption is that the
parser can eventually be compromised — and the question is what that is worth to
an attacker. One of the properties that keeps the answer "very little" is that
the container cannot reach the internet, so code that manages to execute has
nowhere to send anything.

Publishing a port gives that up, because **the two are mutually exclusive on a
single Docker network.** An `internal: true` network has no route in or out, so
`ports:` silently stops working: the container starts, looks correct in
`docker ps`, and the host gets connection refused. There is no error anywhere to
tell you. Since a host-side proxy has to reach the container, the published port
wins and the network stays a plain bridge.

If you want the property back, you have two options.

**1. Keep the network internal and let nginx reach the container by IP.** The
host *can* route to a container on an internal network even though port
publishing does not work, so this keeps both properties:

```yaml
services:
  converterapi:
    # no `ports:` at all
    networks:
      backend:
        ipv4_address: 172.31.240.10

networks:
  backend:
    internal: true
    ipam:
      config:
        - subnet: 172.31.240.0/24
```

then `proxy_pass http://172.31.240.10:3001;` in nginx. Pick a subnet that does
not collide with anything on your host, and note that the address is now fixed.

**2. Block egress with a `DOCKER-USER` rule**, leaving the published port alone:

```bash
# Substitute the bridge subnet of the compose network.
iptables -I DOCKER-USER -s 172.18.0.0/16 -m conntrack \
  --ctstate NEW -j DROP
```

Docker evaluates `DOCKER-USER` before its own forwarding rules, so this survives
container restarts. It is host-specific, which is why it is not baked into the
compose file.

Doing neither is a reasonable choice too — plenty of deployments accept it — but
make it a choice.

### Verifying a deployment

```bash
curl -sS https://converterapi.example.com/health
curl -sS -F "file=@report.docx" https://converterapi.example.com/convert/pdf -o out.pdf
head -c 5 out.pdf        # %PDF-
```

And confirm the fonts actually resolved on the running host — this is the check
that silently passes while producing wrong pagination:

```bash
docker compose exec converterapi sh -c '
  for f in Calibri Cambria Arial "Times New Roman"; do
    printf "%s -> %s\n" "$f" "$(fc-match -f "%{family}" "$f")"
  done'
# Calibri -> Carlito
# Cambria -> Caladea
# Arial -> Liberation Sans
# Times New Roman -> Liberation Serif
```

---

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite is `node:test` — no test framework dependency.

| File | Covers |
|---|---|
| [`test/integration.test.ts`](test/integration.test.ts) | The real HTTP contract against real conversions: a valid `.docx` returning `%PDF-`, every family in the matrix, the two-slide-to-two-PNG archive, legacy Office extensions, pandoc's markup sources, the archive engine (including malicious-archive rejection), the image-transcode engine (including the ICO size limit and the GIF-as-video edge case), oversized input, wrong extension, unsupported target, unknown target, malformed file, encrypted file, empty file, cleanup, and cancellation. |
| [`test/archive.test.ts`](test/archive.test.ts) | `validateEntries`'s pre-extraction arithmetic directly: the entry-count and declared-size caps, path-traversal and symlink rejection, encrypted-entry detection — the same hand-built-list-not-real-multi-hundred-MB-file shape `test/tables.test.ts` uses for `readZipEntry`'s own bomb defence. |
| [`test/media.test.ts`](test/media.test.ts) | The real `/media/{target}` job lifecycle end to end — accept, poll, download — against real audio/video ffmpeg synthesises with its own `lavfi` test sources; unknown target, unsupported extension, cross-kind and self-conversion rejection, and the `404`/`409` job-lookup cases. |
| [`test/unit.test.ts`](test/unit.test.ts) | Matrix self-consistency, prototype-safe lookups, the ZIP writer and its zip-slip guard, the probe-document builders, queue bounds and `E_BUSY`, the rate limiter, encryption detection, workspace sweeping, and the exact user-facing strings. |
| [`test/timeout.test.ts`](test/timeout.test.ts) | The 90s deadline, in a child process so `CONVERT_TIMEOUT_MS` can be overridden. |
| [`test/preflight.test.ts`](test/preflight.test.ts) | The boot refusal, by starting the real entry point with a broken environment — a missing `soffice`, a missing `pdftoppm`, and an unresolvable `fc-match`. |
| [`test/openapi.test.ts`](test/openapi.test.ts) | That [`openapi.yaml`](openapi.yaml) still describes this service: codes, exact messages, upload limit, and the responses the endpoints really return. |
| [`test/fixtures.ts`](test/fixtures.ts) | Binary fixtures built in code — including hand-built OLE/CFB containers, since there is no way to produce a password-protected document without a copy of Word or a checked-in blob. |

The suite needs a working `soffice`, `pdftoppm`, `pandoc`, `7z` and `ffmpeg`,
plus `genisoimage` for the one `.iso` fixture, but **not** the fonts: the
tests exercise the HTTP contract, which holds either way, so they run
through `createApp()` rather than `startServer()` and skip preflight.

Documents used as test input are built in code rather than checked in — a
`.docx` from four OOXML parts, an `.odp` from four ODF parts, a PNG from raw
scanlines and a `deflateSync`. One fixture is generated rather than
built: the `.pptx` the PPTX-source tests need, produced once per run by
converting the ODP fixture with `soffice`. Hand-writing a PPTX means writing a
theme, a slide master and a layout and wiring them together, at which point the
fixture becomes the thing under test. The raster pipeline itself is tested
against the hand-built `.odp`, so it has no dependency on that generation step.

---

## Notes from building this

Four things that were true and surprising, recorded because they are the kind of
detail that is expensive to rediscover.

**`--convert-to` exits 0 when it fails.** A corrupt document prints
`Error: source file could not be loaded` and returns status **0**. Checking the
exit code alone gives you a service that reports success while producing
nothing. The only trustworthy signal is a non-empty file that starts with
`%PDF-`.

**LibreOffice sniffs content, so the extension is a filter *hint*, not a
guarantee.** A plain text file renamed to `.docx` converts perfectly happily —
it is imported as Writer text and exported as a PDF. Two consequences: a
"malformed document" test has to use bytes that actually fail the import filter
(this suite uses a ZIP header followed by garbage), and the extension check is
about *routing*, not about validating that the content matches.

**A zero-byte upload produces a valid blank PDF.** LibreOffice opens an empty
file as an empty document and exports one page. Without an explicit check this
is a `200` carrying a document the user never had, so empty uploads are rejected
before conversion.

**Type stripping rejects constructor parameter properties.** Running `.ts`
directly through Node's `--experimental-strip-types` is dependency-free and
fast, but it is strip-only: `constructor(private readonly x: number)` is a syntax
error. It also does not rewrite import specifiers, so imports use `.ts`
extensions and `tsc` rewrites them to `.js` for the build
(`rewriteRelativeImportExtensions`).

**LibreOffice's command-line image export writes one slide and stops.** Covered
in full under [Image targets](#image-targets-and-why-they-need-poppler). It cost
a while to establish that this was a genuine limitation rather than a wrong
filter name — the giveaway is that other filter options for the *same* filter
are honoured, so the options are parsed and `PageRange` is specifically
disregarded.

**"Idempotent cleanup" had to mean more than "harmless to call twice".** The
workspace is deleted from three places, because which one runs depends on how
the request ended. The first version nulled the workspace path before awaiting
the delete, so a second caller saw nothing to do, returned instantly, and let
the response go out while the directory was still being removed — the exact
opposite of the documented promise that the disk is reclaimed before the client
has its answer. It now remembers the in-flight promise and hands the same one to
every caller. An integration test that compares the temp directory either side
of a request is what caught it.

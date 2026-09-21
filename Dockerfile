# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# LibreOffice headless is the conversion engine.
#
# ALL FOUR APPLICATION MODULES ARE REQUIRED, not just the writer. They are
# separate packages, and a container with only libreoffice-writer converts every
# Word document perfectly while failing every spreadsheet and every presentation
# - silently, because the writer module does not know or care that Calc is
# missing. That was the shape of this image before the service became a
# universal converter.
#
#   writer   .docx .docm .doc .odt .rtf .txt .html .epub
#   calc     .xlsx .ods .csv
#   impress  .pptx .odp, and the PNG/JPG targets
#   draw     the image sources (.png .jpg .jpeg -> PDF)
#
# poppler-utils is the rasteriser. It is NOT an optimisation: LibreOffice's
# command-line image export writes only the FIRST slide of a presentation, and
# ignores the PageRange filter option that is supposed to change that. Rendering
# an intermediate PDF is the only way to get one image per slide, which is what
# the PNG/JPG targets promise.
#
# python3 plus pdf2docx/pdfplumber/python-pptx/openpyxl is a SECOND, unrelated
# conversion engine, needed because LibreOffice cannot produce the `word`,
# `slides` or `sheet` targets AT ALL: a PDF opens in LibreOffice as a Draw
# document, and Draw has no Writer/Calc/Impress export filter - confirmed by
# running `soffice --convert-to docx/pptx/xlsx` against a real PDF and getting
# "no export filter found" every time. `scripts/pdf_engine.py` is what those
# three targets run instead. Installed with `--break-system-packages` into the
# system site-packages (not `--user`) so it resolves regardless of $HOME -
# `pdf-engine.service.ts` explains why that distinction matters.
#
# python-docx is listed explicitly even though pdf2docx already depends on it -
# pdf_engine.py imports it directly for the Type3-font fallback (see
# `_convert_to_docx_as_pages`), so it is this script's own dependency now, not
# merely something that happens to be present because pdf2docx needs it too.
#
# qpdf is a FOURTH, unrelated engine, needed because pdf-lib (which does every
# other page operation - merge, split, rotate, watermark) is explicit in its
# own README that it does not implement PDF encryption at all. `/pdf/protect`
# and `/pdf/unlock` shell out to qpdf instead, a small dependency-free CLI
# built for exactly this. See qpdf.service.ts.
#
# tesseract-ocr plus ocrmypdf is a FIFTH engine, for a PDF with no
# extractable text at all (a scan) asking for `docx`. pdf2docx has no OCR of
# its own - its `ocr=1` setting is an unimplemented stub in the installed
# version, confirmed by reading pdf2docx's own source - so a real OCR pass
# has to run first and hand pdf2docx a PDF that already has a text layer to
# read (`ocr=2`). See `_ocr_pdf` in pdf_engine.py. Language packs beyond
# English are for this service's own real documents (Azerbaijani, Turkish -
# the same alphabet family and the same "print to PDF" behaviour - and
# Russian, common alongside them); override OCR_LANGUAGES if a deployment's
# documents are in different languages, and add the matching
# tesseract-ocr-<lang> package here to match.
#
# The font packages are NOT optional and NOT cosmetic. Calibri and Cambria do
# not exist on Linux; without metric-compatible substitutes LibreOffice picks a
# font with different glyph widths, so every line breaks in a different place
# and the PDF paginates differently from Word - while converting successfully
# and looking perfectly correct. `fonts-liberation` does the same job for Arial,
# Times New Roman and Courier New.
#
# ttf-mscorefonts-installer is deliberately NOT used: it needs an interactive
# EULA acceptance, which breaks unattended image builds, and the metric-
# compatible set above is a drop-in replacement for the metrics that pagination
# actually depends on. See README "Fonts".
#
# fonts-dejavu is for a different job than the three above: it is the
# substitute font pdf_engine.py's `_rebuild_pdf_without_type3_fonts` draws
# INTO a PDF, not one LibreOffice picks for itself, and pagination-matching
# is irrelevant to it. What matters is Unicode coverage - checked directly
# against every font already in this image, `fonts-crosextra-caladea`
# (metric-compatible with Cambria, otherwise the obvious choice for a serif
# Type3 report) turned out to be MISSING Azerbaijani's schwa (`ə`), silently
# dropping every occurrence when used; DejaVu Serif has it. The full
# `fonts-dejavu` package, not `-core`: `-core` ships only Regular and Bold,
# no italic (needed for this same report's italic captions), and installing
# the wrong one fails at first use, not at build time.
#
# pandoc is a SIXTH, unrelated engine, for the markup/plain-text sources
# (.md .rst .tex .textile .org .opml .muse .ipynb) reaching docx/html/odt/
# rtf/txt/markdown. None of these is a document LibreOffice opens, so - the
# same story as the PDF engine above - there is no `--convert-to` for any of
# them. See `pandoc.service.ts`. Debian's package is missing the `asciidoc`
# reader (confirmed with `pandoc --list-input-formats`), which is why `.adoc`
# is not in the matrix - see the note at the top of that file.
#
# p7zip-full is a SEVENTH, unrelated engine: `7z`, for the archive sources
# (.zip/.tar/.tgz/.tbz2/.txz/.gz/.bz2/.xz/.7z/.iso) reaching zip/tar/
# tar.gz/tar.bz2/7z. Converting an archive to another archive format means
# genuinely unpacking untrusted bytes to disk - new ground for this service,
# see `archive.service.ts`'s own header comment for the mitigations that
# exist because of it (list-before-extract, symlinks refused outright, path
# traversal checked ourselves ahead of 7z's own defence, per-request
# workspace isolation, only a zero exit is trusted). RAR (`.rar`) is
# deliberately not in the matrix: `7z` can only ever read it, never write
# it, and there is no legal way to author a real `.rar` fixture to verify
# reading against - see the note on `.rar` in formats.ts.
#
# ffmpeg is an EIGHTH, unrelated engine, doing two separate jobs:
#
#   - the image-transcode sources (.bmp/.gif/.tiff/.webp/.avif/.ico, plus
#     making .png/.jpg/.jpeg real sources) reaching bmp/gif/tiff/webp/avif/
#     ico, synchronously, as part of POST /convert/{target}. Unlike soffice
#     this is a flat format-to-format tool with no document family to key a
#     filter on - see `ffmpeg.service.ts`. `-frames:v 1 -update 1` is
#     mandatory on every one of these calls, not cosmetic: without it, a
#     GIF/WEBP source (decoded as a tiny video, not a still image) trips
#     ffmpeg's image2 muxer into "Cannot write more than one file with the
#     same name" and the conversion fails outright - verified by hand. ICO
#     cannot hold an image over 256x256 (a real format limit, also verified
#     by hand); this service does not silently downscale to make that
#     succeed, same as every other target.
#   - real audio/video transcoding for POST /media/{target} (mp3/wav/flac/
#     ogg/aac/m4a/wma, mp4/webm/mkv/avi/mov/flv), asynchronously - its own
#     job-based endpoint, not part of /convert/{target}'s synchronous
#     contract. See the README's "POST /media/{target}" section and
#     `media-jobs.service.ts` for why: a real transcode routinely exceeds
#     CONVERT_TIMEOUT_MS and needs an upload ceiling far above
#     MAX_UPLOAD_BYTES, neither of which /convert/{target}'s existing
#     contract can be changed to accommodate without breaking it for every
#     other target.
#
# The service refuses to boot without any of this. Preflight checks soffice,
# `pdftoppm`, `pandoc`, `7z`, `ffmpeg` and the fonts, and then converts one
# real document per family (plus one pandoc case, one archive case and one
# ffmpeg case) before it listens - so a missing module fails loudly at
# startup rather than on some user's first spreadsheet, days later.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-draw \
      poppler-utils \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation \
      fonts-dejavu \
      fonts-opensymbol \
      fontconfig \
      ca-certificates \
      python3 \
      python3-pip \
      qpdf \
      pandoc \
      p7zip-full \
      ffmpeg \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-aze \
      tesseract-ocr-tur \
      tesseract-ocr-rus \
 && fc-cache -f \
 && pip3 install --no-cache-dir --break-system-packages \
      pdf2docx \
      pdfplumber \
      python-pptx \
      openpyxl \
      python-docx \
      ocrmypdf \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    TEMP_ROOT=/tmp/converterapi \
    HOME=/tmp

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# config.ts resolves this relative to itself (one level up from dist/ or
# src/), so it has to land at /app/scripts regardless of which one runs.
COPY scripts ./scripts

# signature-fonts.ts resolves this the same way, two levels up from
# dist/services/ or src/services/, for the embedded Dancing Script TTF
# `/pdf/sign` uses for typed cursive signatures/initials.
COPY assets ./assets

# The OpenAPI document is read at runtime (served at /openapi.json and /docs),
# not compiled, so it has to be copied across separately. src/openapi.ts
# resolves it as `../openapi.yaml`, which lands here from dist/.
COPY openapi.yaml ./

# Unprivileged. The service refuses to start as root, and the image already
# ships a `node` user (uid 1000) - so there is nothing to create.
USER node

EXPOSE 3001

# The start period covers preflight plus the warm-up conversion.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

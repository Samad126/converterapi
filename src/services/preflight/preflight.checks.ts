/**
 * Individual "can this dependency even run" checks, one per engine.
 *
 * Split out of preflight.service.ts: these are binary-presence checks, a
 * different responsibility from warmup.service.ts's real conversions and from
 * preflight.service.ts's orchestration of both.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  ARROW_ENGINE_SCRIPT,
  ASSIMP_BIN,
  EBOOK_CONVERT_BIN,
  FFMPEG_BIN,
  FONT_ENGINE_SCRIPT,
  HEIF_CONVERT_BIN,
  HEIF_ENC_BIN,
  PANDOC_BIN,
  PDFTOPPM_BIN,
  PDF_ENGINE_SCRIPT,
  PYTHON_BIN,
  QPDF_BIN,
  REQUIRED_FONT_ALIASES,
  SEVENZIP_BIN,
  SOFFICE_BIN,
  TESSERACT_BIN,
  ZSTD_BIN,
} from '../../config.ts';
import { PreflightError } from '../../errors.ts';

export function assertNotRoot(): void {
  // LibreOffice parses untrusted documents; that parser is the entire attack
  // surface. Running it as uid 0 turns any bug in it into a total compromise of
  // the container, so a uid-0 process is a misconfiguration, not a convenience.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new PreflightError(
      [
        'Refusing to start as root (uid 0).',
        '',
        'This service parses untrusted documents with LibreOffice. Running that',
        'parser as root means any bug in it compromises the whole container.',
        'Run it as an unprivileged user - the provided Dockerfile and',
        'docker-compose.yml already do this.',
      ].join('\n'),
    );
  }
}

export function assertSofficePresent(): string {
  const result = spawnSync(SOFFICE_BIN, ['--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: process.env.HOME ?? '/tmp' },
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${SOFFICE_BIN}" (${code ?? result.error.message}).`,
        '',
        'LibreOffice headless is the conversion engine - there is no fallback.',
        '  Debian/Ubuntu:  apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set SOFFICE_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${SOFFICE_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim().split('\n')[0] ?? '';
}

/**
 * The rasteriser, needed by the PNG and JPG targets.
 *
 * Checked at boot like everything else rather than at first use: without it,
 * "convert this deck to PNG" fails long after the request arrived, with an
 * error that reads like a problem with the user's file.
 */
export function assertRasterizerPresent(): string {
  const result = spawnSync(PDFTOPPM_BIN, ['-v'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${PDFTOPPM_BIN}" (${code ?? result.error.message}).`,
        '',
        'It renders the intermediate PDF of a PNG/JPG conversion into one image',
        'per slide, which LibreOffice cannot do from the command line.',
        '  Debian/Ubuntu:  apt-get install -y poppler-utils',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set PDFTOPPM_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  // `pdftoppm -v` reports its version on stderr in some builds and stdout in
  // others, and exits 0 either way - so accept either stream, and only treat a
  // non-zero exit as failure.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || output === '') {
    throw new PreflightError(
      `"${PDFTOPPM_BIN} -v" exited ${result.status} with no version output.`,
    );
  }
  return output.split('\n')[0] ?? '';
}

/**
 * The `docx`/`pptx`/`xlsx` targets FROM A PDF, needed because LibreOffice
 * cannot produce them at all that way.
 *
 * A PDF opens in LibreOffice as a Draw document, and Draw has no Writer/Calc/
 * Impress export filter - confirmed by running `soffice --convert-to` for
 * each of them against a real PDF and getting "no export filter found" every
 * time. `scripts/pdf_engine.py` is a second, independent conversion engine
 * for exactly that reason, and it fails exactly the way the LibreOffice
 * modules do if its dependencies are missing: not at boot, on whichever
 * user's PDF asks for a Word document first. Checked the same way
 * `assertSofficePresent` checks its own dependency - can the interpreter be
 * run at all - plus a check that is specific to this engine: are its three
 * packages actually importable, since a partially-installed Python
 * environment runs and then fails, which `spawnSync -c "import ..."` would
 * rather see happen now.
 */
export function assertPdfEnginePresent(): void {
  const result = spawnSync(
    PYTHON_BIN,
    ['-c', 'import pdf2docx, pptx, pdfplumber, openpyxl, fitz, docx, ocrmypdf'],
    { encoding: 'utf8', timeout: 30_000 },
  );

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${PYTHON_BIN}" (${code ?? result.error.message}).`,
        '',
        'It runs scripts/pdf_engine.py, which is what turns a PDF into an',
        'editable DOCX/PPTX/XLSX - LibreOffice cannot do this at all, because a',
        'PDF opens in it as a Draw document and Draw has no Writer/Calc/Impress',
        'export filter.',
        '  Docker:  use the provided Dockerfile',
        '',
        'Set PYTHON_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      [
        'The PDF engine\'s Python dependencies are not all installed.',
        '',
        `  pip install pdf2docx pdfplumber python-pptx openpyxl python-docx ocrmypdf`,
        '  Docker:  use the provided Dockerfile',
        '',
        `stderr: ${(result.stderr ?? '').trim()}`,
      ].join('\n'),
    );
  }
  if (!existsSync(PDF_ENGINE_SCRIPT)) {
    throw new PreflightError(`PDF engine script missing: ${PDF_ENGINE_SCRIPT}`);
  }
}

/**
 * qpdf, needed by `/pdf/protect` and `/pdf/unlock`.
 *
 * pdf-lib does every other page operation in this service, but its own
 * README says encryption is out of scope for it - there is no path in it
 * that sets a PDF password at all. qpdf is checked the same way soffice and
 * the rasteriser are: can it even be run, before any request depends on it.
 */
export function assertQpdfPresent(): void {
  const result = spawnSync(QPDF_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${QPDF_BIN}" (${code ?? result.error.message}).`,
        '',
        'It adds and removes PDF passwords for /pdf/protect and /pdf/unlock -',
        'pdf-lib, which does every other page operation, does not implement PDF',
        'encryption at all.',
        '  Debian/Ubuntu:  apt-get install -y qpdf',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set QPDF_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${QPDF_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
}

/**
 * pandoc, needed by the markup sources (`.md`/`.rst`/`.tex`/`.textile`/
 * `.org`/`.opml`/`.muse`/`.ipynb`) asking for `docx`/`html`/`odt`/`rtf`/
 * `txt`/`markdown`.
 *
 * Checked the same way qpdf is: can it even be run, before any request
 * depends on it. `warmUp()`'s `.md -> docx` case is what proves it produces
 * REAL output, not just that the binary exists - the same division of labour
 * `assertPdfEnginePresent`/its own warm-up pair already uses.
 */
export function assertPandocPresent(): string {
  const result = spawnSync(PANDOC_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${PANDOC_BIN}" (${code ?? result.error.message}).`,
        '',
        'It converts the markup sources (.md/.rst/.tex/.textile/.org/.opml/',
        '.muse/.ipynb) to docx/html/odt/rtf/txt/markdown - none of these is a',
        'document LibreOffice opens, so there is no --convert-to for any of',
        'them.',
        '  Debian/Ubuntu:  apt-get install -y pandoc',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set PANDOC_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${PANDOC_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').split('\n')[0]?.trim() ?? 'unknown';
}

/**
 * `7z` (p7zip), needed by the archive sources (`.zip`/`.tar`/`.tgz`/
 * `.tbz2`/`.txz`/`.gz`/`.bz2`/`.xz`/`.7z`/`.iso`) asking for `zip`/`tar`/
 * `tar.gz`/`tar.bz2`/`7z`.
 *
 * Checked the same way pandoc is: can it even be run, before any request
 * depends on it. `warmUp()`'s `.tar -> zip` case is what proves it actually
 * lists, unpacks and repacks a real archive correctly - not just that the
 * binary exists.
 */
export function assertSevenZipPresent(): string {
  const result = spawnSync(SEVENZIP_BIN, ['--help'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${SEVENZIP_BIN}" (${code ?? result.error.message}).`,
        '',
        'It lists, unpacks and repacks the archive sources (.zip/.tar/.tgz/',
        '.tbz2/.txz/.gz/.bz2/.xz/.7z/.iso) reaching zip/tar/tar.gz/tar.bz2/7z -',
        'none of these is a document LibreOffice, pandoc or pdf_engine.py open.',
        '  Debian/Ubuntu:  apt-get install -y p7zip-full',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set SEVENZIP_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  // `7z --help` exits 0 on this build even without an archive argument;
  // a non-zero exit here means the binary itself is broken, not merely that
  // no file was given.
  if (result.status !== 0) {
    throw new PreflightError(
      `"${SEVENZIP_BIN} --help" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').split('\n')[0]?.trim() ?? 'unknown';
}

/**
 * `ffmpeg`, needed by the image-transcode sources (`.bmp`/`.gif`/`.tiff`/
 * `.webp`/`.avif`/`.ico`, plus `.png`/`.jpg`/`.jpeg` as real sources)
 * reaching `bmp`/`gif`/`tiff`/`webp`/`avif`/`ico`.
 *
 * Checked the same way pandoc/7z are: can it even be run, before any
 * request depends on it. `warmUp()`'s `.png -> webp` case is what proves it
 * actually decodes and re-encodes a real image - not just that the binary
 * exists.
 */
export function assertFfmpegPresent(): string {
  const result = spawnSync(FFMPEG_BIN, ['-version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${FFMPEG_BIN}" (${code ?? result.error.message}).`,
        '',
        'It transcodes the image sources (.bmp/.gif/.tiff/.webp/.avif/.ico,',
        'plus .png/.jpg/.jpeg) to bmp/gif/tiff/webp/avif/ico - none of these',
        'is a document LibreOffice, pandoc or pdf_engine.py open.',
        '  Debian/Ubuntu:  apt-get install -y ffmpeg',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set FFMPEG_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${FFMPEG_BIN} -version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').split('\n')[0]?.trim() ?? 'unknown';
}

/**
 * `heif-convert`/`heif-enc` (Debian/Ubuntu package: `libheif-examples`),
 * needed for `.heic`/`.heif` in EITHER direction - the one pair `ffmpeg`
 * cannot reach at all in this build (verified by hand: no HEIF demuxer or
 * encoder). See `heif.engine.ts` and `formats.ts`'s own `heif` mode bullet.
 *
 * Checked the same way `ffmpeg`/pandoc/7z are: can each tool even be run,
 * before any request depends on it. Two binaries, one check, because a
 * container missing either one fails half of every `.heic`/`.heif` request -
 * `heif-convert` alone can decode a source but never produce one, and
 * `heif-enc` alone is the reverse.
 */
export function assertHeifPresent(): string {
  for (const [bin, purpose] of [
    [HEIF_CONVERT_BIN, 'decodes .heic/.heif sources'],
    [HEIF_ENC_BIN, 'encodes .heic/.heif targets'],
  ] as const) {
    const result = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      throw new PreflightError(
        [
          `Cannot run "${bin}" (${code ?? result.error.message}).`,
          '',
          `It ${purpose} - neither ffmpeg nor LibreOffice can read or write this`,
          'format in this build.',
          '  Debian/Ubuntu:  apt-get install -y libheif-examples',
          '  Docker:         use the provided Dockerfile',
          '',
          `Set ${bin === HEIF_CONVERT_BIN ? 'HEIF_CONVERT_BIN' : 'HEIF_ENC_BIN'} if it is installed somewhere not on PATH.`,
        ].join('\n'),
      );
    }
    if (result.status !== 0) {
      throw new PreflightError(
        `"${bin} --help" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
      );
    }
  }
  const versionResult = spawnSync(HEIF_CONVERT_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return (versionResult.stdout ?? '').split('\n')[0]?.trim() ?? 'unknown';
}

/**
 * `zstd`, needed for `.zst`/`tar.zst` in either direction - `7z` has no
 * Zstandard codec in this build at all (verified by hand: `7z l`/`7z a
 * -tzstd` both fail with "Unsupported archive type"), unlike gzip/bzip2/xz,
 * which it reads and writes natively. See `archive.engine.ts`.
 */
export function assertZstdPresent(): string {
  const result = spawnSync(ZSTD_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${ZSTD_BIN}" (${code ?? result.error.message}).`,
        '',
        'It decompresses .zst sources and compresses tar.zst targets - 7z has',
        'no Zstandard codec in this build at all.',
        '  Debian/Ubuntu:  apt-get install -y zstd',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set ZSTD_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${ZSTD_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim() || 'unknown';
}

/**
 * `assimp` (Debian/Ubuntu package: `assimp-utils`), the 3D-model engine -
 * `.obj`/`.stl`/`.ply`/`.glb`/`.3mf`/`.off` in, any of `obj`/`stl`/`ply`/
 * `glb`/`3mf` out. See `assimp.engine.ts`.
 */
export function assertAssimpPresent(): string {
  const result = spawnSync(ASSIMP_BIN, ['version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${ASSIMP_BIN}" (${code ?? result.error.message}).`,
        '',
        'It reads and writes every 3D-model format this service offers',
        '(.obj/.stl/.ply/.glb/.3mf/.off) - no other engine here can.',
        '  Debian/Ubuntu:  apt-get install -y assimp-utils',
        '  Docker:         use the provided Dockerfile',
        '',
        'Set ASSIMP_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${ASSIMP_BIN} version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'unknown';
}

/**
 * Calibre's `ebook-convert` (Debian/Ubuntu package: `calibre`), the ebook
 * engine - `.epub`/`.mobi`/`.azw3`/`.fb2`/`.lrf`/`.pdb` in, any of `epub`/
 * `mobi`/`azw3`/`fb2`/`lrf`/`pdb`/`snb`/KEPUB out. See `ebook.engine.ts`.
 */
export function assertEbookConvertPresent(): string {
  const result = spawnSync(EBOOK_CONVERT_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${EBOOK_CONVERT_BIN}" (${code ?? result.error.message}).`,
        '',
        'It reads and writes every ebook format this service offers',
        '(.epub/.mobi/.azw3/.fb2/.lrf/.pdb/snb/kepub) - no other engine here can.',
        '  Debian/Ubuntu:  apt-get install -y calibre',
        '  Docker:         use the provided Dockerfile',
        '',
        `Set EBOOK_CONVERT_BIN if it is installed somewhere not on PATH.`,
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      `"${EBOOK_CONVERT_BIN} --version" exited ${result.status}. stderr: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').split('\n')[0]?.trim() ?? 'unknown';
}

/**
 * `fontTools`, the font engine (`.ttf`/`.otf`/`.woff`/`.woff2`). Same shape
 * as `assertPdfEnginePresent` above - a Python module, not a standalone
 * binary, checked by actually importing it. See `font.engine.ts`/
 * `font_engine.py`.
 */
export function assertFontEnginePresent(): void {
  const result = spawnSync(PYTHON_BIN, ['-c', 'import fontTools'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${PYTHON_BIN}" (${code ?? result.error.message}).`,
        '',
        'It runs scripts/font_engine.py, the .ttf/.otf/.woff/.woff2 engine.',
        '  Docker:  use the provided Dockerfile',
        '',
        'Set PYTHON_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      [
        'fontTools is not installed.',
        '',
        '  Debian/Ubuntu:  apt-get install -y python3-fonttools',
        '  Docker:         use the provided Dockerfile',
        '',
        `stderr: ${(result.stderr ?? '').trim()}`,
      ].join('\n'),
    );
  }
  if (!existsSync(FONT_ENGINE_SCRIPT)) {
    throw new PreflightError(`Font engine script missing: ${FONT_ENGINE_SCRIPT}`);
  }
}

/**
 * `pyarrow`, the columnar-data engine (`.parquet`/`.orc`/`.feather`). Same
 * shape as `assertPdfEnginePresent` above. Installed via pip, not a Debian
 * package - see `config.ts`'s own `ARROW_ENGINE_SCRIPT` comment for why.
 * See `arrow.service.ts`/`arrow_engine.py`.
 */
export function assertArrowEnginePresent(): void {
  const result = spawnSync(PYTHON_BIN, ['-c', 'import pyarrow, pyarrow.parquet, pyarrow.orc, pyarrow.feather'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new PreflightError(
      [
        `Cannot run "${PYTHON_BIN}" (${code ?? result.error.message}).`,
        '',
        'It runs scripts/arrow_engine.py, the .parquet/.orc/.feather engine.',
        '  Docker:  use the provided Dockerfile',
        '',
        'Set PYTHON_BIN if it is installed somewhere not on PATH.',
      ].join('\n'),
    );
  }
  if (result.status !== 0) {
    throw new PreflightError(
      [
        'pyarrow is not installed.',
        '',
        '  pip install pyarrow',
        '  Docker:  use the provided Dockerfile',
        '',
        `stderr: ${(result.stderr ?? '').trim()}`,
      ].join('\n'),
    );
  }
  if (!existsSync(ARROW_ENGINE_SCRIPT)) {
    throw new PreflightError(`Arrow engine script missing: ${ARROW_ENGINE_SCRIPT}`);
  }
}

/**
 * tesseract, used by `ocrmypdf` for a scanned PDF (no extractable text at
 * all) asking for `docx`.
 *
 * Deliberately NOT a `PreflightError`, unlike every other check in this
 * file: OCR is a best-effort enhancement to an already-working target, not
 * a target of its own - `pdf_engine.py`'s `_ocr_pdf` already degrades to a
 * plain, non-OCR conversion (the same result this service gave a scanned
 * PDF before OCR existed) if tesseract is missing or fails, rather than
 * failing the request. Refusing to boot over a missing enhancement would be
 * exactly the "gap of its own" this file exists to prevent elsewhere, turned
 * inside out. A missing tesseract is logged instead, so it is visible
 * without being fatal.
 */
export function checkTesseractPresent(): boolean {
  const result = spawnSync(TESSERACT_BIN, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return !result.error && result.status === 0;
}

export function assertMetricCompatibleFonts(): Array<{ requested: string; resolved: string }> {
  const resolvedFonts: Array<{ requested: string; resolved: string }> = [];
  const missing: Array<{ requested: string; expect: string; pkg: string; got: string }> = [];

  for (const alias of REQUIRED_FONT_ALIASES) {
    const result = spawnSync('fc-match', ['-f', '%{family}', alias.requested], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    if (result.error) {
      throw new PreflightError(
        [
          'Cannot run "fc-match", so the installed fonts cannot be verified.',
          '',
          '  Debian/Ubuntu:  apt-get install -y fontconfig',
          '',
          'This check exists because missing fonts fail silently: LibreOffice',
          'substitutes a font with different metrics and every line breaks in a',
          'different place, so the PDF paginates differently from Word while',
          'still looking perfectly fine.',
        ].join('\n'),
        { cause: result.error },
      );
    }

    const resolved = (result.stdout ?? '').trim();
    // fc-match reports a fallback chain, e.g. "Carlito,Calibri" or
    // "Liberation Sans,Arial". The expected family must appear in it.
    const families = resolved.split(',').map((f) => f.trim());
    if (!families.includes(alias.expect)) {
      missing.push({ ...alias, got: resolved || '(nothing)' });
    } else {
      resolvedFonts.push({ requested: alias.requested, resolved: alias.expect });
    }
  }

  if (missing.length > 0) {
    const packages = [...new Set(missing.map((m) => m.pkg))];
    throw new PreflightError(
      [
        'Refusing to start: the metric-compatible font set is not installed.',
        '',
        ...missing.map(
          (m) =>
            `  ${m.requested.padEnd(16)} resolved to "${m.got}", expected ${m.expect}  (${m.pkg})`,
        ),
        '',
        'WHY THIS IS FATAL: Calibri and Cambria do not exist on Linux. Without',
        'these packages LibreOffice substitutes a font with different metrics, so',
        'every line breaks in a different place and the PDF paginates differently',
        'from Word - while still converting successfully and looking correct.',
        'Nothing else in the system would ever report a problem.',
        '',
        'Install them:',
        `  Debian/Ubuntu:  apt-get install -y ${packages.join(' ')}`,
        '  Then refresh the font cache:  fc-cache -f',
        '',
        'The real Microsoft core fonts (ttf-mscorefonts-installer) are NOT the',
        'answer: they need an interactive EULA acceptance, which is exactly the',
        'kind of thing that breaks an unattended image build, and the metric-',
        'compatible set above is a drop-in replacement for the metrics that',
        'pagination actually depends on. See README "Fonts".',
      ].join('\n'),
    );
  }

  return resolvedFonts;
}

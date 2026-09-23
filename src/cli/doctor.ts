/**
 * `converter doctor` - checks which of the system tools this CLI shells out
 * to (LibreOffice, ffmpeg, qpdf, pandoc, Calibre, ...) are actually on this
 * machine, and prints an install hint for whichever ones are missing.
 *
 * Deliberately NOT the server's own `preflight()` (services/
 * preflight.service.ts): that function is fail-fast (throws on the FIRST
 * missing tool) and its messages hard-code `apt-get`, because it only ever
 * runs inside the Debian-based Docker image this service ships as. This CLI
 * runs on whatever machine a person has - Linux, macOS or Windows - so it
 * checks every tool independently and picks its install hint from
 * `process.platform`, rather than assuming Debian.
 */
import { spawnSync } from 'node:child_process';

import {
  ASSIMP_BIN,
  EBOOK_CONVERT_BIN,
  FFMPEG_BIN,
  HEIF_CONVERT_BIN,
  HEIF_ENC_BIN,
  PANDOC_BIN,
  PDFTOPPM_BIN,
  PYTHON_BIN,
  QPDF_BIN,
  SEVENZIP_BIN,
  SOFFICE_BIN,
  TESSERACT_BIN,
  ZSTD_BIN,
} from '../config.ts';

type Platform = 'linux' | 'darwin' | 'win32' | 'other';

function currentPlatform(): Platform {
  if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32') {
    return process.platform;
  }
  return 'other';
}

interface ToolCheck {
  /** What this tool is FOR, in one clause - shown next to a failure so "qpdf" means something. */
  usedFor: string;
  bin: string;
  /** Args that make the tool print something and exit 0 without doing real work. */
  versionArgs: string[];
  hints: Partial<Record<Platform, string>>;
}

const TOOLS: ToolCheck[] = [
  {
    usedFor: 'documents, spreadsheets, presentations (docx/xlsx/pptx/odt/pdf/...)',
    bin: SOFFICE_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw',
      darwin: 'brew install --cask libreoffice',
      win32: 'winget install --id TheDocumentFoundation.LibreOffice  (or download from libreoffice.org)',
    },
  },
  {
    usedFor: 'rasterising slides/pages to PNG/JPG',
    bin: PDFTOPPM_BIN,
    versionArgs: ['-v'],
    hints: {
      linux: 'apt-get install -y poppler-utils',
      darwin: 'brew install poppler',
      win32: 'winget install --id oschwartz10612.Poppler  (or add a poppler build to PATH)',
    },
  },
  {
    usedFor: 'markup formats (md/rst/tex/org/...) and text document conversions',
    bin: PANDOC_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y pandoc',
      darwin: 'brew install pandoc',
      win32: 'winget install --id JohnMacFarlane.Pandoc',
    },
  },
  {
    usedFor: 'PDF password protect/unlock/repair/compress',
    bin: QPDF_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y qpdf',
      darwin: 'brew install qpdf',
      win32: 'winget install --id QPDF.QPDF',
    },
  },
  {
    usedFor: 'archive formats (zip/tar/7z/gz/bz2/xz/...)',
    bin: SEVENZIP_BIN,
    versionArgs: [],
    hints: {
      linux: 'apt-get install -y p7zip-full',
      darwin: 'brew install sevenzip  (installs as "7zz" - set SEVENZIP_BIN=7zz)',
      win32: 'winget install --id 7zip.7zip  (then set SEVENZIP_BIN to the full path of 7z.exe)',
    },
  },
  {
    usedFor: 'image transcoding and real audio/video conversion',
    bin: FFMPEG_BIN,
    versionArgs: ['-version'],
    hints: {
      linux: 'apt-get install -y ffmpeg',
      darwin: 'brew install ffmpeg',
      win32: 'winget install --id Gyan.FFmpeg',
    },
  },
  {
    usedFor: 'HEIC/HEIF photo conversion',
    bin: HEIF_CONVERT_BIN,
    versionArgs: [],
    hints: {
      linux: 'apt-get install -y libheif-examples',
      darwin: 'brew install libheif',
      win32: 'no standard Windows build - build libheif from source, or skip HEIC/HEIF conversions',
    },
  },
  {
    usedFor: 'HEIC/HEIF photo conversion',
    bin: HEIF_ENC_BIN,
    versionArgs: [],
    hints: {
      linux: 'apt-get install -y libheif-examples',
      darwin: 'brew install libheif',
      win32: 'no standard Windows build - build libheif from source, or skip HEIC/HEIF conversions',
    },
  },
  {
    usedFor: '.zst / .tar.zst archives',
    bin: ZSTD_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y zstd',
      darwin: 'brew install zstd',
      win32: 'winget install --id Facebook.Zstandard',
    },
  },
  {
    usedFor: '3D model formats (obj/stl/ply/glb/3mf)',
    bin: ASSIMP_BIN,
    versionArgs: ['version'],
    hints: {
      linux: 'apt-get install -y assimp-utils',
      darwin: 'brew install assimp',
      win32: 'no standard winget package - build/install Open Asset Import Library manually',
    },
  },
  {
    usedFor: 'ebook formats (epub/mobi/azw3/fb2/...)',
    bin: EBOOK_CONVERT_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y calibre',
      darwin: 'brew install --cask calibre',
      win32: 'winget install --id calibre.calibre',
    },
  },
  {
    usedFor: 'OCR on scanned PDFs (optional - conversions still work without it, just without text)',
    bin: TESSERACT_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y tesseract-ocr',
      darwin: 'brew install tesseract',
      win32: 'winget install --id UB-Mannheim.TesseractOCR',
    },
  },
  {
    usedFor: 'PDF<->docx/pptx/xlsx, columnar data (parquet/orc/feather), font conversion',
    bin: PYTHON_BIN,
    versionArgs: ['--version'],
    hints: {
      linux: 'apt-get install -y python3 python3-pip && pip3 install --break-system-packages pdf2docx pdfplumber python-pptx openpyxl python-docx ocrmypdf pyarrow fonttools',
      darwin: 'brew install python3 && pip3 install pdf2docx pdfplumber python-pptx openpyxl python-docx ocrmypdf pyarrow fonttools',
      win32: 'winget install --id Python.Python.3.12 && pip install pdf2docx pdfplumber python-pptx openpyxl python-docx ocrmypdf pyarrow fonttools',
    },
  },
];

function isInstalled(tool: ToolCheck): boolean {
  const result = spawnSync(tool.bin, tool.versionArgs, { stdio: 'ignore' });
  // `error` is set for ENOENT (binary not found) and similar spawn failures.
  // A tool that exists but rejects its version flag still exits (status is a
  // number, possibly non-zero) rather than erroring at spawn - that counts
  // as installed, since this is only checking "is it on PATH", not "does it
  // behave".
  return result.error === undefined;
}

export async function runDoctor(): Promise<void> {
  const platform = currentPlatform();
  const missing: ToolCheck[] = [];

  for (const tool of TOOLS) {
    if (!isInstalled(tool)) missing.push(tool);
  }

  if (missing.length === 0) {
    process.stdout.write('All required tools were found on PATH. You are good to go.\n');
    return;
  }

  process.stdout.write(`${missing.length} of ${TOOLS.length} tools are missing on this machine`);
  process.stdout.write(platform === 'other' ? ':\n\n' : ` (${platform}):\n\n`);

  for (const tool of missing) {
    process.stdout.write(`  ✗ ${tool.bin}\n`);
    process.stdout.write(`    used for: ${tool.usedFor}\n`);
    const hint = platform === 'other' ? undefined : tool.hints[platform];
    if (hint) {
      process.stdout.write(`    install:  ${hint}\n`);
    } else {
      process.stdout.write(
        `    install:  no install hint for this platform - see the Dockerfile's comments for what "${tool.bin}" is and where it normally ships from.\n`,
      );
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    `If a tool is installed but under a different name or path, point the CLI at it with an\n` +
      `environment variable instead of reinstalling - e.g. SOFFICE_BIN=/Applications/LibreOffice.app/Contents/MacOS/soffice.\n` +
      `See config.ts for every *_BIN variable this converter reads.\n`,
  );
  process.exitCode = 1;
}

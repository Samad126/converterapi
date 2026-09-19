/**
 * Refusing to boot into a service that cannot do its job.
 *
 * Every condition checked here fails SILENTLY if you skip it. A missing soffice
 * gives you a service that returns 500s; missing fonts give you something far
 * worse - a service that returns 200 with a PDF whose pagination disagrees with
 * Word. Nobody notices the second one until a customer does.
 *
 * Since the service became a universal converter, "can it do its job" is no
 * longer one question. A container with `libreoffice-writer` and nothing else
 * converts every Word document perfectly and fails every spreadsheet, so the
 * boot check has to exercise each family rather than just prove that soffice
 * exists. `warmUp()` is what does that, by running one real conversion per
 * pipeline - including the two-step PDF-then-rasterise path for the Impress
 * family, which is the only way a missing poppler is ever noticed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import {
  PDFTOPPM_BIN,
  PDF_ENGINE_SCRIPT,
  PYTHON_BIN,
  QPDF_BIN,
  REQUIRED_FONT_ALIASES,
  SOFFICE_BIN,
} from '../config.ts';
import { PreflightError } from '../errors.ts';
import { archivesFiles, resolveConversion, type AllowedExtension, type TargetId } from '../formats.ts';
import { MANIFEST_FILENAME } from '../lib/psd-layers.ts';
import {
  calcProbe,
  impressProbe,
  pdfProbe,
  PSD_PROBE_DRAWABLE_LAYERS,
  psdProbe,
  tablesProbe,
  writerProbe,
} from '../lib/probe-documents.ts';
import { readZipEntry } from '../lib/unzip.ts';
import { convert } from './conversion.service.ts';
import { protectWithQpdf, unlockWithQpdf } from './qpdf.service.ts';
import { createWorkspace, inputFileNameFor, removeWorkspace } from './workspace.service.ts';

export interface PreflightReport {
  sofficeVersion: string;
  rasterizerVersion: string;
  fonts: Array<{ requested: string; resolved: string }>;
}

export async function preflight(): Promise<PreflightReport> {
  assertNotRoot();
  const sofficeVersion = assertSofficePresent();
  const rasterizerVersion = assertRasterizerPresent();
  const fonts = assertMetricCompatibleFonts();
  assertPdfEnginePresent();
  assertQpdfPresent();
  return { sofficeVersion, rasterizerVersion, fonts };
}

function assertNotRoot(): void {
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

function assertSofficePresent(): string {
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
function assertRasterizerPresent(): string {
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
function assertPdfEnginePresent(): void {
  const result = spawnSync(
    PYTHON_BIN,
    ['-c', 'import pdf2docx, pptx, pdfplumber, openpyxl, fitz'],
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
        `  pip install pdf2docx pdfplumber python-pptx openpyxl`,
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
function assertQpdfPresent(): void {
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

function assertMetricCompatibleFonts(): Array<{ requested: string; resolved: string }> {
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

export interface WarmUpCase {
  extension: AllowedExtension;
  target: TargetId;
  document: () => Buffer;
}

/**
 * One real conversion per pipeline, at boot.
 *
 * These are not smoke tests, they are EARLY FAILURES. Preflight proves soffice
 * runs and the fonts resolve; it does not prove the Calc module is installed or
 * that the rasteriser can be reached from inside this process. Both of those
 * are invisible until a user asks for exactly that conversion, which could be
 * days after a deploy that broke it.
 *
 * They also pay the one-off cost of the first-run profile creation per family,
 * which would otherwise land on whichever unlucky user asked first.
 *
 * One case per FAMILY, because that is the unit a missing package comes in:
 * soffice ships as separate writer/calc/impress/draw modules, and a container
 * with only the first converts every Word document perfectly while failing
 * everything else.
 *
 * The Impress case goes through PNG rather than PDF on purpose. That is the
 * two-process pipeline, so it is the only case that proves soffice AND the
 * rasteriser work together - and the probe has two slides, so it also proves
 * the one-image-per-slide promise rather than just that something was written.
 * A workbook that renders a deck perfectly and then emits only the first slide
 * would otherwise fail on some user's upload instead of here.
 */
const WARM_UP_CASES: readonly WarmUpCase[] = [
  { extension: '.docx', target: 'pdf', document: writerProbe },
  { extension: '.csv', target: 'pdf', document: calcProbe },
  { extension: '.odp', target: 'png', document: impressProbe },
  // The extract pipeline touches none of the above: it is our own reader and
  // our own workbook writer, so neither a missing LibreOffice module nor a
  // missing poppler has anything to say about it. It gets a case for the
  // opposite reason - a fault in it is a fault in OUR code, and the boot check
  // is the only place it can be caught before a user's document is the thing
  // that finds it.
  { extension: '.docx', target: 'tables', document: tablesProbe },
  // The layers extractor is a second engine that reaches nothing outside this
  // process, so it gets a case for the same reason `tables` does: a fault in
  // it is a fault in our own reader or our own PNG writer, and the boot check
  // is the only place either can be caught before a user's document is.
  { extension: '.psd', target: 'layers', document: psdProbe },
  // The PDF engine is a THIRD conversion engine, and a different shape of
  // fault than either of the above: `assertPdfEnginePresent` already proves
  // the Python interpreter runs and its packages import, but not that
  // spawning it from Node, writing its output to `outDir` and reading that
  // output back all actually work together. A PDF's `docx` exercises that
  // whole path; its `pptx` and `xlsx` share every part of it except which
  // `pdf_engine.py` operation runs, so a fault reachable only through one of
  // them specifically is far more likely to be in the PDF itself than in this
  // plumbing.
  { extension: '.pdf', target: 'docx', document: pdfProbe },
];

export interface WarmUpReport {
  cases: Array<{ extension: string; target: string; bytes: number }>;
}

export async function warmUp(): Promise<WarmUpReport> {
  const cases: WarmUpReport['cases'] = [];

  for (const warmUpCase of WARM_UP_CASES) {
    const conversion = resolveConversion(warmUpCase.extension, warmUpCase.target);
    if (!conversion) {
      // A matrix that does not contain its own warm-up case is a bug in
      // formats.ts, not a host problem - but it must not start either.
      throw new PreflightError(
        `Warm-up case ${warmUpCase.extension} -> ${warmUpCase.target} is not in the conversion matrix.`,
      );
    }

    const workspace = await createWorkspace();
    try {
      await fsp.writeFile(
        join(workspace, inputFileNameFor(warmUpCase.extension)),
        warmUpCase.document(),
      );

      const result = await convert({ workspace, conversion });
      const bytes = result.files.reduce((total, file) => total + file.data.length, 0);
      if (bytes === 0) {
        throw new PreflightError(
          `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced no output.`,
        );
      }
      // A raster target must produce one image per slide, and the Impress probe
      // has two. Silently dropping all but the first page is the exact failure
      // the two-step pipeline exists to avoid, and it is invisible from the
      // response - a zip with one entry looks like a perfectly good answer.
      if (conversion.target.mode === 'raster' && result.files.length < 2) {
        throw new PreflightError(
          `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced ${result.files.length} image(s) for a two-slide document.`,
        );
      }
      // A single-file answer comes in more than one shape, and which one is
      // expected is the matrix's answer rather than the mode's: `tables`
      // puts however many tables it finds into ONE workbook, while a PDF's
      // `docx`/`pptx`/`xlsx` (`viaEngine`) produce whichever OOXML package
      // their id names, which is not a workbook unless that id is `xlsx`.
      // Checking the wrong shape here would pass a pipeline that had quietly
      // started unwrapping differently from what `GET /formats` promises.
      if ((conversion.target.mode === 'extract' || conversion.viaEngine) && !archivesFiles(conversion.target)) {
        if (result.files.length !== 1) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced ${result.files.length} files for a single-file target.`,
          );
        }
        // Read the workbook back with our own ZIP reader. A file that is the
        // right size but has no workbook part inside it is a package no reader
        // will open - which is precisely the failure this pipeline shipped
        // with the first time it was run, and the reason boot checks it. Only
        // `tables` produces a workbook here; a PDF's `docx`/`pptx` are proved
        // instead by the OOXML signature check every single-file target gets
        // below, and a PDF's `xlsx` is a genuine workbook too but goes
        // through `pdf_engine.py` rather than this in-process writer, so it
        // is deliberately left to the same signature check rather than this
        // one.
        if (warmUpCase.target === 'tables') {
          const workbook = readZipEntry(result.files[0]!.data, 'xl/workbook.xml', 1024 * 1024);
          if (workbook.kind !== 'found') {
            throw new PreflightError(
              `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a package with no readable xl/workbook.xml.`,
            );
          }
        }
        // Every single-file target here writes a ZIP-based OOXML package
        // (.docx/.pptx/.xlsx all are), so the local-file-header signature is
        // a cheap, target-agnostic proof that the pipeline - `tables`'s own
        // writer, or pdf_engine.py for a `viaEngine` pair - wrote a real
        // package and not, say, an empty file or a stack trace.
        const zipSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        if (!result.files[0]!.data.subarray(0, 4).equals(zipSignature)) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a file that is not a ZIP-based package.`,
          );
        }
      }

      // The multi-file extract: one image per drawable layer, and a manifest
      // naming them. The probe's layers are chosen so that the expected count
      // depends on every counting rule at once, so this asserts the number that
      // actually matters rather than merely that something was written - which
      // no other check in the system would catch, because the archive still
      // unzips and every file in it is still a perfectly good PNG.
      if (archivesFiles(conversion.target) && conversion.target.mode === 'extract') {
        const images = result.files.filter((file) => file.name.endsWith('.png'));
        const manifest = result.files.find((file) => file.name === MANIFEST_FILENAME);
        if (images.length !== PSD_PROBE_DRAWABLE_LAYERS) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced ${images.length} image(s), expected ${PSD_PROBE_DRAWABLE_LAYERS}.`,
          );
        }
        if (!manifest) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced no ${MANIFEST_FILENAME}.`,
          );
        }
        // The manifest has to parse and agree with what was written, because
        // the two are built from one walk and a client joins them by filename.
        const parsed = JSON.parse(manifest.data.toString('utf8')) as {
          exported?: number;
          canvas?: { width?: number };
        };
        if (parsed.exported !== images.length || parsed.canvas?.width !== 16) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a manifest that disagrees with the archive.`,
          );
        }
        // Every image really is a PNG. The signature is the only part of that
        // a byte count cannot fake, and a layer written as something else would
        // otherwise be served as image/png and rejected by whatever opens it.
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        for (const image of images) {
          if (!image.data.subarray(0, 8).equals(signature)) {
            throw new PreflightError(
              `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a file that is not a PNG: ${image.name}.`,
            );
          }
        }
      }

      cases.push({
        extension: warmUpCase.extension,
        target: warmUpCase.target,
        bytes,
      });
    } catch (error) {
      if (error instanceof PreflightError) throw error;

      // The advice has to match the pipeline. Sending someone to apt-get for a
      // fault in our own reader would have them install packages that cannot
      // fix it, which is worse than saying nothing.
      const advice = conversion.viaEngine
        ? [
            'The service can start, but it cannot serve this conversion. This runs',
            'scripts/pdf_engine.py, not LibreOffice - `assertPdfEnginePresent`',
            'already proved python3 runs and its packages import, so this is a',
            'fault in that script or in spawning it, not a missing package.',
          ]
        : conversion.target.mode === 'extract'
          ? [
              'The service can start, but it cannot serve this conversion. Nothing',
              'outside this process is involved in it - no LibreOffice, no',
              'rasteriser - so this is a fault in the extractor or in the workbook',
              'writer, not a missing package.',
            ]
          : [
              'The service can start, but it cannot serve this conversion - which is',
              'how a container built with only part of LibreOffice behaves. Check that',
              'every module is installed:',
              '  Debian/Ubuntu:  apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw poppler-utils',
            ];

      throw new PreflightError(
        [
          `Warm-up conversion ${warmUpCase.extension} -> ${warmUpCase.target} failed.`,
          '',
          ...advice,
          '',
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'),
        { cause: error },
      );
    } finally {
      await removeWorkspace(workspace).catch(() => {});
    }
  }

  await warmUpQpdf(cases);

  return { cases };
}

/**
 * A real protect-then-unlock round trip, at boot.
 *
 * Not a `WarmUpCase`: qpdf is not part of the conversion matrix
 * `resolveConversion` describes at all, it is a fourth engine reached only
 * from `/pdf/protect` and `/pdf/unlock`. `assertQpdfPresent` already proves
 * the binary runs; this proves spawning it, writing its output next to a
 * request's input, and reading that output back all actually work together -
 * the same gap between "the interpreter runs" and "the whole pipeline works"
 * that `assertPdfEnginePresent`/this warm-up pair covers for the PDF engine.
 */
async function warmUpQpdf(cases: WarmUpReport['cases']): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const inputPath = join(workspace, 'probe.pdf');
    const protectedPath = join(workspace, 'protected.pdf');
    const unlockedPath = join(workspace, 'unlocked.pdf');
    await fsp.writeFile(inputPath, pdfProbe());

    const password = 'preflight-probe';
    const deadline = Date.now() + 30_000;

    const protectOutcome = await protectWithQpdf({
      inputPath,
      outputPath: protectedPath,
      workspace,
      deadline,
      password,
    });
    if (protectOutcome.kind !== 'exited' || protectOutcome.exitCode !== 0) {
      throw new PreflightError(
        `Warm-up qpdf --encrypt failed: ${JSON.stringify(protectOutcome)}`,
      );
    }
    const protectedBytes = await fsp.readFile(protectedPath);
    if (protectedBytes.length === 0) {
      throw new PreflightError('Warm-up qpdf --encrypt produced an empty file.');
    }

    const unlockOutcome = await unlockWithQpdf({
      inputPath: protectedPath,
      outputPath: unlockedPath,
      workspace,
      deadline,
      password,
    });
    if (unlockOutcome.kind !== 'exited' || unlockOutcome.exitCode !== 0) {
      throw new PreflightError(
        `Warm-up qpdf --decrypt failed: ${JSON.stringify(unlockOutcome)}`,
      );
    }
    const unlockedBytes = await fsp.readFile(unlockedPath);
    if (unlockedBytes.length === 0) {
      throw new PreflightError('Warm-up qpdf --decrypt produced an empty file.');
    }

    cases.push({ extension: '.pdf', target: 'protect+unlock (qpdf)', bytes: unlockedBytes.length });
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(
      [
        'Warm-up qpdf protect/unlock round trip failed.',
        '',
        'The service can start, but /pdf/protect and /pdf/unlock will not work.',
        'assertQpdfPresent already proved qpdf runs, so this is a fault in',
        'spawning it or in reading its output back, not a missing package.',
        '',
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
      { cause: error },
    );
  } finally {
    await removeWorkspace(workspace).catch(() => {});
  }
}

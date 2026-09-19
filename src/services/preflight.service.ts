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
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { PDFTOPPM_BIN, REQUIRED_FONT_ALIASES, SOFFICE_BIN } from '../config.ts';
import { PreflightError } from '../errors.ts';
import { resolveConversion, type AllowedExtension, type TargetId } from '../formats.ts';
import { calcProbe, impressProbe, tablesProbe, writerProbe } from '../lib/probe-documents.ts';
import { readZipEntry } from '../lib/unzip.ts';
import { convert } from './conversion.service.ts';
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
      // An extract target answers with exactly one workbook - several tables
      // become several sheets, not several files. More than one file would
      // mean the response shape had changed without formats.ts saying so, and
      // a client that unwraps a ZIP on the strength of `multiple: false` would
      // hand the user a workbook it could not read.
      if (conversion.target.mode === 'extract') {
        if (result.files.length !== 1) {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced ${result.files.length} files for a single-workbook target.`,
          );
        }
        // Read the workbook back with our own ZIP reader. A file that is the
        // right size but has no workbook part inside it is a package no reader
        // will open - which is precisely the failure this pipeline shipped
        // with the first time it was run, and the reason boot checks it.
        const workbook = readZipEntry(result.files[0]!.data, 'xl/workbook.xml', 1024 * 1024);
        if (workbook.kind !== 'found') {
          throw new PreflightError(
            `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a package with no readable xl/workbook.xml.`,
          );
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
      const advice =
        conversion.target.mode === 'extract'
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

  return { cases };
}

/**
 * One real conversion per pipeline, at boot.
 *
 * Split out of preflight.service.ts: this is proof that each engine actually
 * WORKS end to end, a different responsibility from preflight.checks.ts's
 * "can this binary even run" checks.
 *
 * These are not smoke tests, they are EARLY FAILURES. `preflight()` proves
 * soffice runs and the fonts resolve; it does not prove the Calc module is
 * installed or that the rasteriser can be reached from inside this process.
 * Both of those are invisible until a user asks for exactly that conversion,
 * which could be days after a deploy that broke it.
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
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { archivesFiles, resolveConversion, type AllowedExtension, type TargetId } from '../../formats.ts';
import { PreflightError } from '../../errors.ts';
import { MANIFEST_FILENAME } from '../../lib/psd-layers.ts';
import {
  buildSolidPng,
  calcProbe,
  impressProbe,
  markdownProbe,
  pdfProbe,
  PSD_PROBE_DRAWABLE_LAYERS,
  psdProbe,
  tarProbe,
  tablesProbe,
  writerProbe,
} from '../../lib/probe-documents.ts';
import { readZipEntry } from '../../lib/unzip.ts';
import { convert } from '../../pipelines/conversion.pipeline.ts';
import { protectWithQpdf, unlockWithQpdf } from '../../engines/qpdf.engine.ts';
import { createWorkspace, inputFileNameFor, removeWorkspace } from '../workspace.service.ts';

export interface WarmUpCase {
  extension: AllowedExtension;
  target: TargetId;
  document: () => Buffer;
}

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
  // pandoc is a FOURTH conversion engine, checked the same way the PDF
  // engine is: `assertPandocPresent` proves the binary runs, this proves
  // spawning it from Node, writing `-o` into `outDir` and reading that
  // output back all actually work. `.md -> docx` writes a ZIP-based OOXML
  // package, so it shares the same single-file/OOXML-signature checks below
  // as `tables` and the PDF engine's own cases, rather than needing new ones.
  { extension: '.md', target: 'docx', document: markdownProbe },
  // 7z is a FIFTH conversion engine, checked the same way pandoc is:
  // `assertSevenZipPresent` proves the binary runs, this proves listing,
  // unpacking and repacking a real archive all actually work together -
  // including the code path that writes untrusted archive contents to disk,
  // which is new ground for this service (see archive.engine.ts). `.tar ->
  // zip` specifically exercises the `zip.ts`-backed writer, which is real
  // ZIP-signature output - unlike `tar`/`7z`, whose own signatures the
  // single-file check below does not assert on, so this is the one archive
  // pairing that fits the existing OOXML-signature check without a new one.
  { extension: '.tar', target: 'zip', document: tarProbe },
  // ffmpeg is a SIXTH conversion engine, checked the same way pandoc/7z are:
  // `assertFfmpegPresent` proves the binary runs, this proves it actually
  // decodes a real PNG and re-encodes a real WEBP - not just that the CLI
  // exists. `webp` rather than `bmp`/`gif`/`tiff` because it is the one
  // transcode target this build's libwebp needs to be linked in for, which
  // `-version`'s own banner does not confirm the way running a real
  // encode does.
  { extension: '.png', target: 'webp', document: () => buildSolidPng(4, 4, [200, 40, 40]) },
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
      // `docx`/`pptx`/`xlsx` (an engine pair) produce whichever OOXML
      // package their id names, which is not a workbook unless that id is
      // `xlsx`, and `.png -> webp` (the ffmpeg case) produces neither - a
      // RIFF/WEBP container, not a ZIP-based one at all. Checking the wrong
      // shape here would pass a pipeline that had quietly started unwrapping
      // differently from what `GET /formats` promises.
      if (
        (conversion.target.mode === 'extract' || conversion.engine !== 'soffice') &&
        !archivesFiles(conversion.target)
      ) {
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
        // The container signature to check is a fact about the TARGET, not
        // the engine - `docx`/`pptx`/`xlsx`/`tables` are all ZIP-based OOXML
        // packages, `webp` (the ffmpeg case's target) is a RIFF/WEBP
        // container instead. Either way it is a cheap, format-specific proof
        // that the pipeline wrote a real file and not, say, an empty one or
        // a stack trace.
        const bytes = result.files[0]!.data;
        if (warmUpCase.target === 'webp') {
          const isRiffWebp =
            bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP';
          if (!isRiffWebp) {
            throw new PreflightError(
              `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a file that is not a RIFF/WEBP container.`,
            );
          }
        } else {
          const zipSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
          if (!bytes.subarray(0, 4).equals(zipSignature)) {
            throw new PreflightError(
              `Warm-up ${warmUpCase.extension} -> ${warmUpCase.target} produced a file that is not a ZIP-based package.`,
            );
          }
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
      const advice =
        conversion.engine === 'pdf-engine'
          ? [
              'The service can start, but it cannot serve this conversion. This runs',
              'scripts/pdf_engine.py, not LibreOffice - `assertPdfEnginePresent`',
              'already proved python3 runs and its packages import, so this is a',
              'fault in that script or in spawning it, not a missing package.',
            ]
          : conversion.engine === 'pandoc'
            ? [
                'The service can start, but it cannot serve this conversion. This runs',
                '`pandoc`, not LibreOffice - `assertPandocPresent` already proved the',
                'binary runs, so this is a fault in that specific reader/writer pair,',
                'not a missing package.',
              ]
            : conversion.engine === 'archive'
              ? [
                  'The service can start, but it cannot serve this conversion. This runs',
                  '`7z`, not LibreOffice - `assertSevenZipPresent` already proved the',
                  'binary runs, so this is a fault in listing, unpacking or repacking this',
                  'specific archive pair, not a missing package.',
                ]
              : conversion.engine === 'ffmpeg'
                ? [
                    'The service can start, but it cannot serve this conversion. This runs',
                    '`ffmpeg`, not LibreOffice - `assertFfmpegPresent` already proved the',
                    'binary runs, so this is a fault in this specific decoder/encoder pair -',
                    'often a codec this ffmpeg build was not compiled with - not a missing',
                    'package outright.',
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

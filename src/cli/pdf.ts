/**
 * `converter pdf <operation> ...` - the CLI twin of the `/pdf/*` endpoints in
 * `pages.controller.ts`, calling `pdf-pages.service.ts`/`qpdf.engine.ts`
 * directly. Covers the page-manipulation operations that take simple
 * flags; the JSON-element operations (`sign`, `edit`, `redact`, `fill-form`,
 * `compare`) are not exposed here - see the README.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { Errors } from '../errors.ts';
import { parsePageSelection, isPermutationOfAllPages } from '../lib/page-ranges.ts';
import {
  addPageNumbers,
  addWatermark,
  cropPages,
  imagesToPdf,
  mergePdfs,
  pdfPageCount,
  removePages,
  rotatePages,
  selectPages,
  splitPdf,
  type PageNumberPosition,
} from '../services/pdf-pages.service.ts';
import {
  compressWithQpdf,
  protectWithQpdf,
  repairWithQpdf,
  unlockWithQpdf,
  type CompressLevel,
} from '../engines/qpdf.engine.ts';
import type { ProcessOutcome } from '../engines/soffice.engine.ts';
import { createWorkspace, removeWorkspace } from '../services/workspace.service.ts';
import { extensionOf, fail, flagString, parseArgs, readInput, reportError, usageFail, withExtension, writeResult } from './lib.ts';

const OPERATIONS = [
  'merge',
  'split',
  'remove',
  'extract',
  'organize',
  'scan',
  'rotate',
  'watermark',
  'crop',
  'page-numbers',
  'protect',
  'unlock',
  'repair',
  'compress',
] as const;

export async function runPdf(argv: string[]): Promise<void> {
  const [op, ...rest] = argv;
  if (!op || !(OPERATIONS as readonly string[]).includes(op)) {
    fail(
      `usage: converter pdf <operation> <file.pdf> [flags]\n\n` +
        `operations: ${OPERATIONS.join(', ')}\n\n` +
        `Run "converter" with no arguments to see each operation's own flags.`,
    );
  }

  const { positionals, flags } = parseArgs(rest);
  const outDir = flagString(flags, 'out');

  try {
    switch (op as (typeof OPERATIONS)[number]) {
      case 'merge':
        await doMerge(positionals, outDir);
        return;
      case 'split':
        await doSplit(positionals, flagString(flags, 'every'), outDir);
        return;
      case 'remove':
        await doSelect(positionals, flags, outDir, 'remove');
        return;
      case 'extract':
        await doSelect(positionals, flags, outDir, 'extract');
        return;
      case 'organize':
        await doOrganize(positionals, flags, outDir);
        return;
      case 'scan':
        await doScan(positionals, outDir);
        return;
      case 'rotate':
        await doRotate(positionals, flags, outDir);
        return;
      case 'watermark':
        await doWatermark(positionals, flags, outDir);
        return;
      case 'crop':
        await doCrop(positionals, flags, outDir);
        return;
      case 'page-numbers':
        await doPageNumbers(positionals, flags, outDir);
        return;
      case 'protect':
        await doQpdf(positionals, flags, outDir, 'protect');
        return;
      case 'unlock':
        await doQpdf(positionals, flags, outDir, 'unlock');
        return;
      case 'repair':
        await doQpdf(positionals, flags, outDir, 'repair');
        return;
      case 'compress':
        await doQpdf(positionals, flags, outDir, 'compress');
        return;
    }
  } catch (error) {
    reportError(error);
  }
}

async function readPdf(path: string): Promise<Buffer> {
  if (extensionOf(path) !== '.pdf') fail(`"${path}" is not a .pdf file.`);
  const data = await readInput(path);
  if (data.length === 0) fail(`"${path}" is empty.`);
  return data;
}

async function doMerge(files: string[], outDir?: string): Promise<void> {
  if (files.length < 2) {
    usageFail('converter pdf merge <file1.pdf> <file2.pdf> [file3.pdf ...] [--out <dir>]', [
      'converter pdf merge chapter1.pdf chapter2.pdf chapter3.pdf',
    ]);
  }
  const buffers = await Promise.all(files.map(readPdf));
  const merged = await mergePdfs(buffers);
  const [written] = await writeResult([{ name: 'merged.pdf', data: merged }], {
    archive: false,
    downloadName: 'merged.pdf',
    outDir,
  });
  process.stdout.write(`merged ${files.length} files -> ${written}\n`);
}

async function doSplit(files: string[], everyFlag: string | undefined, outDir?: string): Promise<void> {
  const [file] = files;
  if (!file) {
    usageFail('converter pdf split <file.pdf> [--every <n>] [--out <dir>]', [
      'converter pdf split report.pdf --every 5   # one part per 5 pages',
      'converter pdf split report.pdf             # one part per page',
    ]);
  }
  const every = everyFlag === undefined ? 1 : Number.parseInt(everyFlag, 10);
  if (!Number.isInteger(every) || every < 1) fail('--every must be a positive whole number of pages.');

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  if (pageCount === 0) fail(`"${file}" has no pages.`);

  const parts = await splitPdf(buffer, every);
  const written = await writeResult(
    parts.map((data, i) => ({ name: `part-${i + 1}.pdf`, data })),
    { archive: true, downloadName: withExtension(file!, '.zip'), outDir },
  );
  process.stdout.write(`${file} -> ${written[0]} (${parts.length} parts)\n`);
}

async function doSelect(
  files: string[],
  flags: Record<string, string | boolean>,
  outDir: string | undefined,
  mode: 'remove' | 'extract',
): Promise<void> {
  const [file] = files;
  const pages = flagString(flags, 'pages');
  if (!file || !pages) {
    usageFail(`converter pdf ${mode} <file.pdf> --pages <selection> [--out <dir>]`, [
      `converter pdf ${mode} report.pdf --pages 1,3,5-7`,
    ]);
  }

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  const indices = parsePageSelection(pages!, pageCount);

  const result = mode === 'remove' ? await removePages(buffer, new Set(indices)) : await selectPages(buffer, indices);
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doOrganize(files: string[], flags: Record<string, string | boolean>, outDir?: string): Promise<void> {
  const [file] = files;
  const order = flagString(flags, 'order');
  if (!file || !order) {
    usageFail('converter pdf organize <file.pdf> --order <selection> [--out <dir>]', [
      'converter pdf organize report.pdf --order 3,1,2   # reorders a 3-page PDF',
    ]);
  }

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  const indices = parsePageSelection(order!, pageCount);
  if (!isPermutationOfAllPages(indices, pageCount)) {
    throw Errors.badPageRange(
      `The order must name every page exactly once (1-${pageCount}), with no repeats and none missing.`,
    );
  }

  const result = await selectPages(buffer, indices);
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doScan(files: string[], outDir?: string): Promise<void> {
  if (files.length < 1) {
    usageFail('converter pdf scan <image1.png|.jpg> [image2 ...] [--out <dir>]', [
      'converter pdf scan page1.jpg page2.jpg page3.jpg',
    ]);
  }
  const images = await Promise.all(
    files.map(async (path) => {
      const ext = extensionOf(path);
      if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
        fail(`"${path}" must be a .png or .jpg image.`);
      }
      const data = await readInput(path);
      if (data.length === 0) fail(`"${path}" is empty.`);
      const format: 'png' | 'jpg' = ext === '.png' ? 'png' : 'jpg';
      return { data, format };
    }),
  );
  const pdf = await imagesToPdf(images);
  const [written] = await writeResult([{ name: 'scanned.pdf', data: pdf }], {
    archive: false,
    downloadName: 'scanned.pdf',
    outDir,
  });
  process.stdout.write(`scanned ${files.length} images -> ${written}\n`);
}

async function doRotate(files: string[], flags: Record<string, string | boolean>, outDir?: string): Promise<void> {
  const [file] = files;
  const degreesFlag = flagString(flags, 'degrees');
  if (!file || !degreesFlag) {
    usageFail('converter pdf rotate <file.pdf> --degrees <90|180|270|-90> [--pages <selection>] [--out <dir>]', [
      'converter pdf rotate scan.pdf --degrees 90',
      'converter pdf rotate scan.pdf --degrees 180 --pages 2,4',
    ]);
  }

  const delta = Number.parseInt(degreesFlag!, 10);
  if (![90, 180, 270, -90, -180, -270].includes(delta)) fail('--degrees must be one of 90, 180, 270, -90, -180, -270.');

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  const pages = flagString(flags, 'pages');
  const indices = pages ? parsePageSelection(pages, pageCount) : undefined;

  const result = await rotatePages(buffer, delta, indices);
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doWatermark(files: string[], flags: Record<string, string | boolean>, outDir?: string): Promise<void> {
  const [file] = files;
  const text = flagString(flags, 'text');
  if (!file || !text) {
    usageFail('converter pdf watermark <file.pdf> --text <text> [--pages <selection>] [--out <dir>]', [
      'converter pdf watermark report.pdf --text "DRAFT"',
      'converter pdf watermark report.pdf --text "CONFIDENTIAL" --pages 1',
    ]);
  }

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  const pages = flagString(flags, 'pages');
  const indices = pages ? parsePageSelection(pages, pageCount) : undefined;

  const result = await addWatermark(buffer, text!, indices);
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doCrop(files: string[], flags: Record<string, string | boolean>, outDir?: string): Promise<void> {
  const [file] = files;
  if (!file) {
    usageFail(
      'converter pdf crop <file.pdf> [--left <pt>] [--right <pt>] [--top <pt>] [--bottom <pt>] [--pages <selection>] [--out <dir>]',
      [
        'converter pdf crop report.pdf --top 36 --bottom 36   # trim 36pt (0.5in) off top and bottom',
        'converter pdf crop report.pdf --left 20 --right 20 --pages 1-3',
      ],
    );
  }

  const margin = (name: string) => {
    const raw = flagString(flags, name);
    const value = raw === undefined ? 0 : Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number of points.`);
    return value;
  };

  const buffer = await readPdf(file!);
  const pageCount = await pdfPageCount(buffer);
  const pages = flagString(flags, 'pages');
  const indices = pages ? parsePageSelection(pages, pageCount) : undefined;

  const result = await cropPages(
    buffer,
    { left: margin('left'), right: margin('right'), top: margin('top'), bottom: margin('bottom') },
    indices,
  );
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doPageNumbers(files: string[], flags: Record<string, string | boolean>, outDir?: string): Promise<void> {
  const [file] = files;
  if (!file) {
    usageFail(
      'converter pdf page-numbers <file.pdf> [--position bottom-center|bottom-left|bottom-right] [--start-at <n>] [--out <dir>]',
      [
        'converter pdf page-numbers report.pdf',
        'converter pdf page-numbers report.pdf --position bottom-right --start-at 1',
      ],
    );
  }

  const positionFlag = flagString(flags, 'position') ?? 'bottom-center';
  if (!['bottom-center', 'bottom-left', 'bottom-right'].includes(positionFlag)) {
    fail('--position must be one of bottom-center, bottom-left, bottom-right.');
  }
  const startAtFlag = flagString(flags, 'start-at');
  const startAt = startAtFlag === undefined ? 1 : Number.parseInt(startAtFlag, 10);
  if (!Number.isInteger(startAt)) fail('--start-at must be a whole number.');

  const buffer = await readPdf(file!);
  const result = await addPageNumbers(buffer, { position: positionFlag as PageNumberPosition, startAt });
  const downloadName = withExtension(file!, '.pdf');
  const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
  process.stdout.write(`${file} -> ${written}\n`);
}

async function doQpdf(
  files: string[],
  flags: Record<string, string | boolean>,
  outDir: string | undefined,
  op: 'protect' | 'unlock' | 'repair' | 'compress',
): Promise<void> {
  const [file] = files;
  if (!file) {
    const usage: Record<typeof op, { signature: string; examples: string[] }> = {
      protect: {
        signature: 'converter pdf protect <file.pdf> --password <password> [--out <dir>]',
        examples: ['converter pdf protect secret.pdf --password hunter2'],
      },
      unlock: {
        signature: 'converter pdf unlock <file.pdf> --password <password> [--out <dir>]',
        examples: ['converter pdf unlock secret.pdf --password hunter2'],
      },
      repair: {
        signature: 'converter pdf repair <file.pdf> [--out <dir>]',
        examples: ['converter pdf repair damaged.pdf'],
      },
      compress: {
        signature: 'converter pdf compress <file.pdf> [--level low|medium|high] [--out <dir>]',
        examples: ['converter pdf compress big.pdf --level high'],
      },
    };
    usageFail(usage[op].signature, usage[op].examples);
  }
  if (extensionOf(file!) !== '.pdf') fail(`"${file}" is not a .pdf file.`);
  const stat = await fsp.stat(file!).catch(() => fail(`no such file: ${file}`));
  if (stat.size === 0) fail(`"${file}" is empty.`);

  const password = flagString(flags, 'password');
  if ((op === 'protect' || op === 'unlock') && !password) {
    fail(`--password is required for ${op}.`);
  }

  const level = flagString(flags, 'level') as CompressLevel | undefined;
  if (level && !['low', 'medium', 'high'].includes(level)) fail('--level must be one of low, medium, high.');

  const workspace = await createWorkspace();
  try {
    const outputPath = join(workspace, 'output.pdf');
    const deadline = Date.now() + 1000 * 60 * 30;

    let outcome: ProcessOutcome;
    switch (op) {
      case 'protect':
        outcome = await protectWithQpdf({ inputPath: file!, outputPath, workspace, deadline, password: password! });
        break;
      case 'unlock':
        outcome = await unlockWithQpdf({ inputPath: file!, outputPath, workspace, deadline, password: password! });
        break;
      case 'repair':
        outcome = await repairWithQpdf({ inputPath: file!, outputPath, workspace, deadline });
        break;
      case 'compress':
        outcome = await compressWithQpdf({ inputPath: file!, outputPath, workspace, deadline, level });
        break;
    }

    const acceptable = op === 'repair' ? [0, 3] : [0];
    if (outcome.kind === 'timeout') throw Errors.timeout();
    if (outcome.kind === 'aborted') throw new Error('cancelled');
    if (outcome.kind === 'exited' && !acceptable.includes(outcome.exitCode ?? -1)) {
      if (op === 'unlock' && /invalid password/i.test(outcome.stderr)) throw Errors.wrongPassword();
      throw Errors.convertFailed(outcome.stderr || `qpdf exited ${outcome.exitCode}`);
    }

    const result = await fsp.readFile(outputPath);
    if (result.length === 0) throw Errors.convertFailed('qpdf produced an empty file');

    const downloadName = withExtension(file!, '.pdf');
    const [written] = await writeResult([{ name: downloadName, data: result }], { archive: false, downloadName, outDir });
    process.stdout.write(`${file} -> ${written}\n`);
  } finally {
    await removeWorkspace(workspace);
  }
}

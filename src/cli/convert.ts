/**
 * `converter convert <target> <file...>` - the CLI twin of `POST
 * /convert/{target}`, driving `conversion.pipeline.ts` directly instead of
 * through Express/multer.
 *
 * Same workspace shape the HTTP controller builds (`createWorkspace()`, the
 * upload written to `input.<ext>`, `convert()` reading/writing under it) so
 * this exercises the exact same LibreOffice/pandoc/ffmpeg/etc code paths the
 * server does - the CLI is not a reimplementation, it is the same engine
 * with the HTTP layer skipped.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { isAllowedExtension, isTargetId, resolveConversion, targetsFor, type TargetId } from '../formats.ts';
import { convert } from '../pipelines/conversion.pipeline.ts';
import { createWorkspace, inputFileNameFor, removeWorkspace } from '../services/workspace.service.ts';
import { extensionOf, fail, flagString, parseArgs, readInput, reportError, withExtension, writeResult } from './lib.ts';

export async function runConvert(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [target, ...inputs] = positionals;

  if (!target || inputs.length === 0) {
    fail(
      `usage: converter convert <target> <file> [file2] [file3 ...] [--out <dir>] [--ocr=false]\n\n` +
        `You can pass one file, or several - they all convert to the same <target>:\n` +
        `  converter convert pdf report.docx\n` +
        `  converter convert pdf report.docx notes.docx invoice.docx\n\n` +
        `Run "converter formats" to list every target.`,
    );
  }

  if (!isTargetId(target)) {
    fail(`unknown target "${target}". Run "converter formats" to see every supported target.`);
  }

  const outDir = flagString(flags, 'out');
  const ocrFlag = flagString(flags, 'ocr');
  const ocr = ocrFlag === undefined ? true : ocrFlag.toLowerCase() !== 'false';

  for (const inputPath of inputs) {
    await convertOne(inputPath, target, { outDir, ocr });
  }
}

async function convertOne(
  inputPath: string,
  targetId: TargetId,
  options: { outDir?: string; ocr: boolean },
): Promise<void> {
  const extension = extensionOf(inputPath);
  if (!isAllowedExtension(extension)) {
    fail(`"${inputPath}" has an extension (${extension || '<none>'}) this converter does not read.`);
  }

  const conversion = resolveConversion(extension, targetId);
  if (!conversion) {
    fail(
      `"${inputPath}" (${extension}) cannot become ${targetId}. It can become: ` +
        targetsFor(extension).join(', '),
    );
  }

  const data = await readInput(inputPath);
  if (data.length === 0) {
    fail(`"${inputPath}" is empty.`);
  }

  const workspace = await createWorkspace();
  try {
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.writeFile(join(workspace, inputFileNameFor(extension)), data);

    const result = await convert({ workspace, conversion, ocr: options.ocr });

    const downloadName = withExtension(inputPath, result.archive ? '.zip' : conversion.target.extension);
    const written = await writeResult(result.files, {
      archive: result.archive,
      downloadName,
      outDir: options.outDir,
    });

    for (const path of written) {
      process.stdout.write(`${inputPath} -> ${path}\n`);
    }
  } catch (error) {
    reportError(error);
  } finally {
    await removeWorkspace(workspace);
  }
}

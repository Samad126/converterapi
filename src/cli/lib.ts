/**
 * Shared helpers for the `converter` CLI.
 *
 * The CLI calls the same services the HTTP API calls (conversion.pipeline.ts,
 * pdf-pages.service.ts, qpdf.engine.ts, ffmpeg.engine.ts) directly, on the
 * user's own machine, for the user's own files. There is deliberately no
 * rate limiter, queue or upload-size ceiling here: those exist in the HTTP
 * server to protect a shared host from untrusted uploads over the network,
 * and neither concern applies to a person running a local binary against
 * their own disk.
 */
import fsp from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { AppError } from '../errors.ts';
import { zipStored, type ZipEntry } from '../lib/zip.ts';

export function fail(message: string): never {
  process.stderr.write(`converter: ${message}\n`);
  process.exit(1);
}

/**
 * A usage error with at least one worked example, not just the bare
 * `<signature>` a person then has to reverse-engineer into a real command.
 * Every `converter pdf <op>` and `converter <convert|media>` usage message
 * goes through this so they stay in one shape.
 */
export function usageFail(signature: string, examples: string[]): never {
  const exampleLines = examples.map((example) => `  ${example}`).join('\n');
  fail(`usage: ${signature}\n\nexample${examples.length > 1 ? 's' : ''}:\n${exampleLines}`);
}

/**
 * Turns any thrown error into the one-line message the CLI prints and the
 * exit code it uses.
 *
 * `AppError.userMessage` is written for the phone app - a generic, friendly
 * sentence like "This document could not be converted", because the server
 * has already run `preflight()` at boot and knows every engine it might call
 * is installed. The CLI has no such guarantee: a missing `soffice`/`ffmpeg`/
 * `qpdf`/etc surfaces as exactly that same generic sentence, with the real
 * cause - a `spawn ENOENT` - buried in `error.cause` where nobody using this
 * CLI would ever see it. That is the single most likely failure a local
 * install has, so it gets unwrapped and pointed at `converter doctor`
 * instead of being left to look like a corrupt document.
 */
export function reportError(error: unknown): never {
  if (error instanceof AppError) {
    const cause = error.cause;
    const causeText = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '';
    const missingBinary = /ENOENT/.test(causeText);
    if (missingBinary) {
      fail(
        `${error.userMessage}\n\n` +
          `The real cause looks like a missing tool this conversion needs:\n  ${causeText.trim()}\n\n` +
          `Run "converter doctor" to see which system tools (LibreOffice, ffmpeg, qpdf, pandoc, ` +
          `Calibre, ...) are missing on this machine and how to install them.`,
      );
    }
    fail(error.userMessage);
  }
  if (error instanceof Error) {
    fail(error.message);
  }
  fail(String(error));
}

export async function readInput(path: string): Promise<Buffer> {
  try {
    return await fsp.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(`no such file: ${path}`);
    }
    throw error;
  }
}

export function extensionOf(path: string): string {
  return extname(path).toLowerCase();
}

/**
 * Writes one produced file, or several as a ZIP, next to the input unless
 * `--out` says otherwise. Mirrors the HTTP API's own choice ("one file
 * downloads plain, several download as one ZIP") so behaviour stays familiar
 * to anyone who has used the web app.
 */
export async function writeResult(
  files: ZipEntry[],
  options: { archive: boolean; downloadName: string; outDir?: string },
): Promise<string[]> {
  const outDir = options.outDir ? resolve(options.outDir) : process.cwd();
  await fsp.mkdir(outDir, { recursive: true });

  if (!options.archive && files.length === 1) {
    const target = join(outDir, options.downloadName);
    await fsp.writeFile(target, files[0]!.data);
    return [target];
  }

  const archive = zipStored(files);
  const target = join(outDir, options.downloadName.endsWith('.zip') ? options.downloadName : `${options.downloadName}.zip`);
  await fsp.writeFile(target, archive);
  return [target];
}

/** `document.docx` -> `document.pdf`, keeping the original basename. */
export function withExtension(inputPath: string, newExtension: string): string {
  const base = basename(inputPath, extname(inputPath));
  return `${base}${newExtension.startsWith('.') ? newExtension : `.${newExtension}`}`;
}

export function sameDir(inputPath: string): string {
  return dirname(resolve(inputPath));
}

export interface ParsedFlags {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Minimal flag parser: `--name value` and `--name=value` become string flags,
 * a bare `--name` (no following value, or followed by another flag) becomes
 * boolean `true`. Everything else is a positional argument. Good enough for
 * a CLI with a handful of well-known flags per command - not a general
 * argv parser.
 */
export function parseArgs(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

export function flagString(flags: ParsedFlags['flags'], name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    fail(`--${name} needs a value`);
  }
  return value;
}

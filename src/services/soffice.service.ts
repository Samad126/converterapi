/**
 * Running external converters, and surviving it.
 *
 * Two things about running soffice as a service are easy to get wrong, and both
 * fail intermittently rather than loudly:
 *
 *  1. Every invocation needs its OWN user profile
 *     (`-env:UserInstallation=file:///<tmp>/lo-profile`). Without it, concurrent
 *     soffice processes collide over the shared profile directory and
 *     conversions fail or hang at random. This is the single most common cause
 *     of "works on my machine" in a service like this.
 *
 *  2. The metric-compatible fonts must be installed (see config.ts and the
 *     README). Without them LibreOffice substitutes a font with different
 *     metrics for Calibri and Cambria, and every line breaks in a different
 *     place. The document converts, the PDF looks right, and the pagination
 *     quietly disagrees with Word.
 *
 * Both are checked at boot by `preflight()` and both refuse to start the
 * service, because neither one produces an error you would ever notice.
 *
 * The other thing worth knowing is that `--convert-to` exits 0 even when it
 * produced nothing at all, so the exit code carries no information about
 * success. Callers must check the files on disk instead - see
 * `collectProducedFiles`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PDFTOPPM_BIN, SIGKILL_GRACE_MS, SOFFICE_BIN } from '../config.ts';

export type ProcessOutcome =
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

interface RunProcessOptions {
  bin: string;
  args: string[];
  /** Working directory, and the HOME/TMPDIR the child sees. */
  workspace: string;
  /**
   * Absolute epoch time by which the child must be gone. A deadline rather
   * than a duration because some conversions are a pipeline of two processes
   * that share one budget: the client's patience is what we are rationing.
   */
  deadline: number;
  signal?: AbortSignal;
  /** Extra environment on top of the safe baseline. */
  env?: Record<string, string>;
}

/**
 * Spawn one child and resolve when it is definitely finished.
 *
 * "Definitely finished" includes the cases where it had to be killed, which is
 * why this returns an outcome rather than a promise that only rejects on spawn
 * failure: a timeout is an expected result that the caller turns into a
 * specific HTTP error, not an exception to be caught somewhere far away.
 */
function runProcess(options: RunProcessOptions): Promise<ProcessOutcome> {
  const { bin, args, workspace, deadline, signal, env } = options;

  return new Promise<ProcessOutcome>((resolve) => {
    const child = spawn(bin, args, {
      // A new process group, so a timeout can kill the converter AND any
      // helpers it forked. Killing just the direct child can leave a detached
      // helper holding the CPU.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Nothing should write into a real home directory, so point HOME and
        // TMPDIR at this request's workspace.
        HOME: workspace,
        TMPDIR: workspace,
        // Keep output stable regardless of the host's locale, and stop
        // soffice from trying to reach a Java runtime it does not need.
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        SAL_USE_VCLPLUGIN: 'svp',
        JAVA_TOOL_OPTIONS: '',
        ...env,
      },
    });

    let stderr = '';
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    // SIGTERM first so the child can shut down cleanly, SIGKILL shortly after
    // for the case where it is wedged and will never honour a polite request.
    const terminate = () => {
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };

    function onAbort() {
      terminate();
      finish({ kind: 'aborted' });
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a pathological document can make soffice extremely chatty, and
      // this text exists only to explain a failure in the logs.
      if (stderr.length < 8_192) stderr += chunk.toString('utf8');
    });
    // stdout is not read for content, but the stream has to be drained or a
    // full pipe buffer will block the child forever.
    child.stdout?.on('data', () => {});

    const remaining = deadline - Date.now();
    deadlineTimer = setTimeout(() => {
      terminate();
      finish({ kind: 'timeout' });
    }, Math.max(0, remaining));
    deadlineTimer.unref?.();

    if (signal) {
      if (signal.aborted) {
        terminate();
        finish({ kind: 'aborted' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      // spawn itself failed (ENOENT and friends).
      finish({ kind: 'exited', exitCode: null, signal: null, stderr: String(error) });
    });

    child.on('close', (code, signalName) => {
      finish({ kind: 'exited', exitCode: code, signal: signalName, stderr });
    });
  });
}

/**
 * Signal the whole process group, falling back to the direct child.
 *
 * Negative PID targets the group created by `detached: true`. The fallback
 * matters on platforms without process groups, and for the race where the child
 * has already exited and its PID is no longer a valid group.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead. Nothing to do.
    }
  }
}

export interface SofficeRun {
  inputPath: string;
  outDir: string;
  profileDir: string;
  workspace: string;
  /** The `--convert-to` argument, e.g. `pdf:writer_pdf_Export`. */
  convertTo: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runSoffice(run: SofficeRun): Promise<ProcessOutcome> {
  const { inputPath, outDir, profileDir, workspace, convertTo, deadline, signal } = run;

  return runProcess({
    bin: SOFFICE_BIN,
    args: [
      '--headless',
      '--norestore',
      '--invisible',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      // Requirement #1: a private profile per invocation. `pathToFileURL`
      // gives us a correctly escaped file:// URL rather than string
      // concatenation, which breaks on paths with spaces or unicode.
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      convertTo,
      '--outdir',
      outDir,
      inputPath,
    ],
    workspace,
    deadline,
    signal,
  });
}

export interface RasterRun {
  pdfPath: string;
  /** Directory the images land in; also becomes the filename prefix. */
  outDir: string;
  prefix: string;
  format: 'png' | 'jpg';
  dpi: number;
  jpegQuality: number;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

/**
 * Render every page of a PDF to its own image file.
 *
 * This exists because LibreOffice cannot do it. `soffice --convert-to
 * png:impress_png_Export` writes ONE image, the first slide, no matter what the
 * filter options say - PageRange is accepted and then ignored, and PixelWidth
 * proves the options are being parsed at all. Rendering the PDF is the only
 * route to one image per slide, which is what the PNG/JPG targets promise.
 *
 * pdftoppm numbers the pages itself: `slide-1.png`, `slide-2.png`, ... and
 * zero-pads to a consistent width once there are ten or more.
 */
export function rasterizePdf(run: RasterRun): Promise<ProcessOutcome> {
  const { pdfPath, outDir, prefix, format, dpi, jpegQuality, workspace, deadline, signal } = run;

  const args = [
    format === 'png' ? '-png' : '-jpeg',
    '-r',
    String(dpi),
  ];
  if (format === 'jpg') {
    args.push('-jpegopt', `quality=${jpegQuality}`);
  }
  args.push(pdfPath, join(outDir, prefix));

  return runProcess({
    bin: PDFTOPPM_BIN,
    args,
    workspace,
    deadline,
    signal,
  });
}

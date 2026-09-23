/**
 * `scripts/arrow_engine.py` (`pyarrow`), run as a subprocess - the bridge
 * that lets `.parquet`/`.orc`/`.feather` join `data.service.ts`'s own
 * CSV/TSV/JSON/JSONL/YAML/XML/TOML/INI/SQLite group, the same "one common JS
 * value" model every other member of it already shares. See
 * `arrow_engine.py`'s own header comment for why this needs a real
 * subprocess where the rest of that group does not (no comparable JS
 * library exists for any of the three formats), and `config.ts`'s
 * `ARROW_ENGINE_SCRIPT` comment for why it is installed via pip rather than
 * a Debian package.
 *
 * Both functions write/read an intermediate JSON file in the request's own
 * workspace rather than piping through stdin/stdout - the same reason
 * `archive.engine.ts`'s `decompressZstd` writes to a real path instead of a
 * pipe: a predictable, per-request-isolated file the caller can inspect on
 * failure, not a stream this file would have to buffer and error-handle by
 * hand.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { ARROW_ENGINE_SCRIPT, PYTHON_BIN } from '../config.ts';
import { Errors } from '../errors.ts';
import type { TargetId } from '../formats.ts';
import { runProcess, type ProcessOutcome } from '../engines/soffice.engine.ts';

export interface ArrowRun {
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

function throwForArrowOutcome(outcome: ProcessOutcome, step: 'read' | 'write'): void {
  if (outcome.kind === 'timeout') throw Errors.timeout();
  if (outcome.kind === 'aborted') return; // caller's own signal check handles this
  if (outcome.exitCode !== 0) {
    throw Errors.convertFailed(
      `arrow_engine.py ${step} exited ${outcome.exitCode} (signal=${outcome.signal ?? 'none'}): ` +
        `${outcome.stderr || '(no stderr)'}`,
    );
  }
}

/**
 * Read a `.parquet`/`.orc`/`.feather` source into the common JS value every
 * data target serialises from. The format is read from `inputPath`'s own
 * extension by `arrow_engine.py` itself, the same zero-flag convention
 * `assimp export`/`ebook-convert` already use - no extension parameter
 * needed here.
 */
export async function parseArrowSource(inputPath: string, run: ArrowRun): Promise<unknown> {
  const { workspace, deadline, signal } = run;
  const jsonPath = join(workspace, 'arrow-intermediate.json');

  const outcome = await runProcess({
    bin: PYTHON_BIN,
    args: [ARROW_ENGINE_SCRIPT, 'read', inputPath, jsonPath],
    workspace,
    deadline,
    signal,
  });
  throwForArrowOutcome(outcome, 'read');

  const text = await fsp.readFile(jsonPath, 'utf8');
  return JSON.parse(text) as unknown;
}

/** Write the common JS value out as `.parquet`/`.orc`/`.feather` bytes. */
export async function serializeArrowTarget(
  targetId: TargetId,
  value: unknown,
  run: ArrowRun,
): Promise<Buffer> {
  const { workspace, deadline, signal } = run;
  const jsonPath = join(workspace, 'arrow-intermediate.json');
  const outputPath = join(workspace, `arrow-output.${targetId}`);

  await fsp.writeFile(jsonPath, JSON.stringify(value), 'utf8');

  const outcome = await runProcess({
    bin: PYTHON_BIN,
    args: [ARROW_ENGINE_SCRIPT, 'write', jsonPath, outputPath],
    workspace,
    deadline,
    signal,
  });
  if (outcome.kind === 'exited' && outcome.exitCode === 1 && !outcome.stderr?.includes('Traceback')) {
    // `arrow_engine.py`'s own shape check (not a top-level array of flat
    // objects) prints a plain, already-user-facing message rather than a
    // traceback - see its own `run_write`.
    throw Errors.notTabular(
      targetId.toUpperCase(),
      'a flat table of records (a top-level list of flat objects)',
    );
  }
  throwForArrowOutcome(outcome, 'write');

  return fsp.readFile(outputPath);
}

/**
 * engine: CSV/TSV/JSON/JSONL/YAML asking for another data format, answered
 * by data.service.ts - pure JS, no subprocess.
 */
import fsp from 'node:fs/promises';

import { ClientGoneError } from '../../errors.ts';
import { ARROW_EXTENSIONS, ARROW_TARGETS, type AllowedExtension, type TargetFormat } from '../../formats.ts';
import { parseArrowSource, serializeArrowTarget } from '../../services/arrow.service.ts';
import {
  parseDataSource,
  parseSqliteSource,
  serializeDataTarget,
  serializeSqliteTarget,
} from '../../services/data.service.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

/**
 * Read the source into `data.service.ts`'s common JS value and write the
 * target's own serialisation of it. Shaped like `runExtractPipeline`, not
 * like `runFfmpegPipeline`/`runArchivePipeline`: there is no subprocess, no
 * deadline for one to respect, and no output directory for a process to
 * write into - the whole conversion is one function call, so the only thing
 * worth checking before it runs is whether the client is still there.
 */
export async function runDataPipeline(run: {
  inputPath: string;
  sourceExtension: AllowedExtension;
  target: TargetFormat;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, sourceExtension, target, workspace, deadline, signal } = run;
  if (signal?.aborted) throw new ClientGoneError();

  // Two members of this group are bytes, not UTF-8 text - `.sqlite` (pure
  // JS, `node:sqlite`) and `.parquet`/`.orc`/`.feather` (a real subprocess,
  // `arrow_engine.py` via `arrow.service.ts` - see `ARROW_TARGETS`'s own
  // comment in `formats.ts`). READING is resolved first, independently of
  // what the target turns out to be, into the exact same common JS value
  // every text member already produces; WRITING is resolved from that value
  // afterwards, independently of what the source was. Multiplying the two
  // out as one branch per (source kind x target kind) would be the same
  // logic four times over - this is the same value the rest of the group
  // shares, just read and written through a different door for these three
  // extensions/targets.
  const value = ARROW_EXTENSIONS.has(sourceExtension)
    ? await parseArrowSource(inputPath, { workspace, deadline, signal })
    : sourceExtension === '.sqlite'
      ? parseSqliteSource(await fsp.readFile(inputPath))
      : parseDataSource(sourceExtension, await fsp.readFile(inputPath, 'utf8'));

  if (ARROW_TARGETS.has(target.id)) {
    const data = await serializeArrowTarget(target.id, value, { workspace, deadline, signal });
    return [{ name: `converted${target.extension}`, data }];
  }
  if (target.id === 'sqlite') {
    return [{ name: `converted${target.extension}`, data: serializeSqliteTarget(value) }];
  }
  const serialized = serializeDataTarget(target.id, value);
  return [{ name: `converted${target.extension}`, data: Buffer.from(serialized, 'utf8') }];
}

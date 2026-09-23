/**
 * engine: `.eml` reaching the existing txt/html targets - see
 * email.service.ts. Pure JS, no subprocess, shaped like runExtractPipeline.
 */
import fsp from 'node:fs/promises';

import { ClientGoneError } from '../../errors.ts';
import type { TargetFormat } from '../../formats.ts';
import { renderEmailAsHtml, renderEmailAsText } from '../../services/email.service.ts';
import type { ProducedFile } from '../conversion.pipeline.ts';

export async function runEmailPipeline(run: {
  inputPath: string;
  target: TargetFormat;
  signal?: AbortSignal;
}): Promise<ProducedFile[]> {
  const { inputPath, target, signal } = run;
  if (signal?.aborted) throw new ClientGoneError();

  const bytes = await fsp.readFile(inputPath);
  const text = target.id === 'html' ? await renderEmailAsHtml(bytes) : await renderEmailAsText(bytes);

  return [{ name: `converted${target.extension}`, data: Buffer.from(text, 'utf8') }];
}

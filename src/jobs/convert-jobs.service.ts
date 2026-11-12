/**
 * The job store behind `POST /convert/{target}/jobs`.
 *
 * `POST /convert/{target}` answers inside one HTTP request, which is a hard
 * ceiling the moment anything in front of the service (Cloudflare's 100s
 * proxy read timeout, a phone's NAT) gives up on a quiet connection. This is
 * the same conversion with the wait taken OUT of the request: the upload is
 * accepted and validated, the response is `202` with a job id, and the
 * conversion carries on in the background while the client asks for its
 * status. `/convert/{target}` itself is unchanged - the Android client's wire
 * contract does not move.
 *
 * Same trade-offs as `media-jobs.service.ts`, deliberately: an in-memory
 * `Map`, lost on restart (a job a deploy interrupts is resubmitted), and no
 * second concurrency pool - the conversion itself still goes through the one
 * shared `BoundedQueue`, so a job takes a conversion slot exactly like a
 * synchronous request does.
 *
 * The result is a file in the job's own workspace, which stays under
 * `TEMP_ROOT`; `CONVERT_JOB_TTL_MS` is kept below `STALE_WORKSPACE_MS` so the
 * generic stale sweep never takes a result a client could still download.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';

import { CONVERT_JOB_TTL_MS } from '../config.ts';
import { AppError, Errors, type ErrorEnvelope } from '../errors.ts';
import { removeWorkspace } from '../services/workspace.service.ts';

export type ConvertJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ConvertJob {
  readonly id: string;
  status: ConvertJobStatus;
  readonly workspace: string;
  resultPath?: string;
  contentType?: string;
  downloadName?: string;
  bytes?: number;
  error?: ErrorEnvelope['error'];
  errorStatus?: number;
  updatedAt: number;
}

/** What the controller's `produce` hands back; structurally a `ConvertOutput`. */
interface JobOutput {
  parts: Buffer[];
  length: number;
  contentType: string;
  downloadName: string;
}

const jobs = new Map<string, ConvertJob>();
const waiters = new Map<string, Set<() => void>>();

export function createConvertJob(input: { workspace: string }): ConvertJob {
  const job: ConvertJob = {
    id: randomUUID(),
    status: 'queued',
    workspace: input.workspace,
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getConvertJob(id: string): ConvertJob | undefined {
  return jobs.get(id);
}

function changed(job: ConvertJob): void {
  job.updatedAt = Date.now();
  const set = waiters.get(job.id);
  if (!set) return;
  waiters.delete(job.id);
  for (const wake of set) wake();
}

/**
 * Resolves when the job next changes state, after `ms`, or when the caller's
 * request goes away - whichever is first. Never rejects.
 */
export function waitForConvertJobChange(job: ConvertJob, ms: number, req: Request): Promise<void> {
  return new Promise<void>((resolve) => {
    const set = waiters.get(job.id) ?? new Set<() => void>();
    waiters.set(job.id, set);
    const done = () => {
      clearTimeout(timer);
      req.off('close', done);
      set.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    req.on('close', done);
    set.add(done);
  });
}

/**
 * Run the conversion in the background. Not awaited by the caller: the `202`
 * goes out first, which is the whole point.
 */
export function startConvertJob(job: ConvertJob, produce: () => Promise<JobOutput>): void {
  job.status = 'running';
  changed(job);
  // A job can wait behind others for a slot. Touching the workspace keeps the
  // generic stale sweep (which goes by the directory's mtime) off it.
  void touch(job.workspace);

  void (async () => {
    try {
      const output = await produce();
      const resultPath = join(job.workspace, 'result.bin');
      const handle = await fsp.open(resultPath, 'w', 0o600);
      try {
        for (const part of output.parts) await handle.write(part);
      } finally {
        await handle.close();
      }
      // The inputs are dead weight once the result is on disk.
      await removeInputs(job.workspace);

      job.resultPath = resultPath;
      job.contentType = output.contentType;
      job.downloadName = output.downloadName;
      job.bytes = output.length;
      job.status = 'done';
    } catch (error) {
      const appError = error instanceof AppError ? error : Errors.internal(error);
      job.status = 'failed';
      job.error = appError.toEnvelope().error;
      job.errorStatus = appError.status;
      await removeInputs(job.workspace);
    }
    void touch(job.workspace);
    changed(job);
  })();
}

async function touch(dir: string): Promise<void> {
  const now = new Date();
  await fsp.utimes(dir, now, now).catch(() => {});
}

async function removeInputs(workspace: string): Promise<void> {
  const entries = await fsp.readdir(workspace).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name !== 'result.bin')
      .map((name) => fsp.rm(join(workspace, name), { recursive: true, force: true }).catch(() => {})),
  );
}

/** Remove finished jobs (and their workspaces) nobody came back for. */
export async function sweepConvertJobs(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const [id, job] of jobs) {
    if ((job.status === 'done' || job.status === 'failed') && now - job.updatedAt > CONVERT_JOB_TTL_MS) {
      await removeWorkspace(job.workspace).catch(() => {});
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

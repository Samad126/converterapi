/**
 * The job store behind `POST /media/{target}` (Phase 5 - audio/video).
 *
 * Everything else in this service answers within one HTTP request; this is
 * the one place that does not, because a real transcode can run for minutes
 * and neither `CONVERT_TIMEOUT_MS` nor a held-open connection is a sane way
 * to wait that out. So the shape here is: accept the upload, create a job,
 * respond `202` with the job's id immediately, and keep converting in the
 * BACKGROUND after the response has already gone out - the caller polls
 * `GET /media/jobs/{id}` for status and `GET /media/jobs/{id}/download` once
 * it says `done`.
 *
 * "No database, no state" is this service's own stated design - so the job
 * store here is exactly what that allows: an in-memory `Map`, lost on
 * restart. A job a deploy interrupts is a job the client has to resubmit,
 * the same as it would be for a `/convert/{target}` request in flight during
 * a restart - this endpoint does not pretend to a durability the rest of the
 * service does not have either.
 *
 * Concurrency goes through `BoundedQueue`, the exact same admission-control
 * primitive `/convert/{target}` uses - but its OWN instance, at
 * `MAX_CONCURRENT_MEDIA_JOBS` (default 1), never `MAX_CONCURRENT_CONVERSIONS`.
 * A video transcode is a heavier, much longer-running neighbour than a
 * document conversion, and the two pools must not compete for the same
 * slots.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import {
  MAX_CONCURRENT_MEDIA_JOBS,
  MAX_QUEUED_MEDIA_JOBS,
  MEDIA_CONVERT_TIMEOUT_MS,
  MEDIA_JOB_TTL_MS,
  MEDIA_TEMP_ROOT,
} from '../config.ts';
import { AppError, Errors, type ErrorEnvelope } from '../errors.ts';
import { mediaFormat, type MediaExtension, type MediaTargetId } from '../formats-media.ts';
import { BoundedQueue } from '../lib/queue.ts';
import { runFfmpegMedia } from './ffmpeg.service.ts';
import { removeWorkspace, sweepStaleWorkspaces } from './workspace.service.ts';

export type MediaJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface MediaJob {
  readonly id: string;
  status: MediaJobStatus;
  readonly sourceExtension: MediaExtension;
  readonly target: MediaTargetId;
  readonly workspace: string;
  /** The name offered back on download - the upload's own name, target extension swapped in. */
  readonly downloadName: string;
  resultPath?: string;
  bytes?: number;
  error?: ErrorEnvelope['error'];
  errorStatus?: number;
  readonly createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, MediaJob>();
const queue = new BoundedQueue(MAX_CONCURRENT_MEDIA_JOBS, MAX_QUEUED_MEDIA_JOBS);

/** Advisory capacity check for the controller, before it accepts a (possibly large) upload. */
export function mediaQueueHasCapacity(): boolean {
  return queue.hasCapacity();
}

/** Create the per-job workspace, under `MEDIA_TEMP_ROOT` - see that constant's own comment for why not `TEMP_ROOT`. */
export async function createMediaWorkspace(): Promise<string> {
  await fsp.mkdir(MEDIA_TEMP_ROOT, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(join(MEDIA_TEMP_ROOT, 'job-'));
}

export function createMediaJob(input: {
  sourceExtension: MediaExtension;
  target: MediaTargetId;
  workspace: string;
  downloadName: string;
}): MediaJob {
  const now = Date.now();
  const job: MediaJob = {
    id: randomUUID(),
    status: 'queued',
    sourceExtension: input.sourceExtension,
    target: input.target,
    workspace: input.workspace,
    downloadName: input.downloadName,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getMediaJob(id: string): MediaJob | undefined {
  return jobs.get(id);
}

/**
 * Start the job converting in the background. Deliberately not awaited by
 * the caller (the controller responds `202` right after this returns, not
 * after the promise it starts settles) - that gap is the entire point of
 * this endpoint existing.
 */
export function startMediaJob(job: MediaJob): void {
  void queue
    .run(undefined, () => processMediaJob(job))
    .catch((error: unknown) => {
      // Reachable if the queue itself is full to its waiting room by the time
      // this job's turn to acquire a slot comes up - the controller already
      // checked `mediaQueueHasCapacity()` before accepting the upload, but
      // that check and this acquire are not atomic. `processMediaJob` itself
      // never rejects (everything inside it is caught into `status:
      // 'failed'`), so any rejection here is this race, not a conversion
      // fault - recorded the same way so a polling client sees a real
      // answer instead of a job stuck at `queued` forever.
      const appError = error instanceof AppError ? error : Errors.internal(error);
      job.status = 'failed';
      job.error = appError.toEnvelope().error;
      job.errorStatus = appError.status;
      job.updatedAt = Date.now();
    });
}

async function processMediaJob(job: MediaJob): Promise<void> {
  job.status = 'running';
  job.updatedAt = Date.now();

  try {
    const inputPath = join(job.workspace, `input${job.sourceExtension}`);
    const outDir = join(job.workspace, 'out');
    await fsp.mkdir(outDir, { recursive: true });
    const target = mediaFormat(job.target);
    const outputPath = join(outDir, `converted${target.extension}`);
    const deadline = Date.now() + MEDIA_CONVERT_TIMEOUT_MS;

    const outcome = await runFfmpegMedia({
      inputPath,
      outputPath,
      workspace: job.workspace,
      deadline,
    });

    if (outcome.kind === 'timeout') throw Errors.timeout();
    if (outcome.kind === 'aborted') {
      // Unreachable in practice - no `signal` is ever passed to a background
      // job, since there is no live request to cancel against by the time
      // this runs - but `ProcessOutcome` still has to be narrowed.
      throw Errors.internal('media job aborted with no signal');
    }
    if (outcome.exitCode !== 0) {
      throw Errors.convertFailed(
        `ffmpeg exited ${outcome.exitCode} (signal=${outcome.signal ?? 'none'}): ` +
          `${outcome.stderr || '(no stderr)'}`,
      );
    }

    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat || stat.size === 0) {
      throw Errors.convertFailed('ffmpeg produced no output file');
    }

    job.status = 'done';
    job.resultPath = outputPath;
    job.bytes = stat.size;
    job.updatedAt = Date.now();
  } catch (error) {
    const appError = error instanceof AppError ? error : Errors.internal(error);
    job.status = 'failed';
    job.error = appError.toEnvelope().error;
    job.errorStatus = appError.status;
    job.updatedAt = Date.now();
  }
}

/**
 * The job-aware half of cleanup: a finished job's workspace is removed
 * `MEDIA_JOB_TTL_MS` after it completed, whether it succeeded or failed -
 * there is nothing left to download either way once that window has passed.
 * A `queued`/`running` job is never touched here, however long it has been
 * running, because its own completion is what starts this clock.
 */
export async function sweepMediaJobs(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'failed') {
      if (now - job.updatedAt > MEDIA_JOB_TTL_MS) {
        await removeWorkspace(job.workspace).catch(() => {});
        jobs.delete(id);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * The crash backstop: a directory under `MEDIA_TEMP_ROOT` with no matching
 * in-memory job at all - because the process restarted and the job store
 * (deliberately in-memory, see this file's own header comment) came back
 * empty while the workspace it made did not. The threshold is generous on
 * purpose (`MEDIA_CONVERT_TIMEOUT_MS + MEDIA_JOB_TTL_MS`, the longest a
 * legitimate job-plus-download-window could ever take), so this can never
 * race a job that is merely slow.
 */
export async function sweepOrphanedMediaWorkspaces(now = Date.now()): Promise<number> {
  return sweepStaleWorkspaces(now, MEDIA_TEMP_ROOT, MEDIA_CONVERT_TIMEOUT_MS + MEDIA_JOB_TTL_MS);
}

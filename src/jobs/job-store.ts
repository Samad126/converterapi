/**
 * The job-store abstraction `media-jobs.service.ts` runs on.
 *
 * Split out on its own so the one stateful seam of this service - "where do
 * jobs live" - is visible as its own file rather than buried at the top of
 * the service that uses it. Everything here talks in terms of `MediaJob`
 * only, never `Map`, so a future swap to a Redis/SQLite-backed store (needed
 * the day this runs as more than one instance behind a load balancer) means
 * adding a new class that implements `MediaJobStore` and changing the one
 * line in `media-jobs.service.ts` that constructs it - no other call site
 * changes.
 */
import type { ErrorEnvelope } from '../errors.ts';
import type { MediaExtension, MediaTargetId } from '../formats-media.ts';

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

export interface MediaJobStore {
  get(id: string): MediaJob | undefined;
  set(job: MediaJob): void;
  delete(id: string): void;
  entries(): IterableIterator<[string, MediaJob]>;
}

export class InMemoryMediaJobStore implements MediaJobStore {
  private readonly jobs = new Map<string, MediaJob>();
  get(id: string): MediaJob | undefined {
    return this.jobs.get(id);
  }
  set(job: MediaJob): void {
    this.jobs.set(job.id, job);
  }
  delete(id: string): void {
    this.jobs.delete(id);
  }
  entries(): IterableIterator<[string, MediaJob]> {
    return this.jobs.entries();
  }
}

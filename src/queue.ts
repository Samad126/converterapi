/**
 * Admission control in front of soffice.
 *
 * soffice converts one document per process and is CPU- and memory-heavy, so
 * the useful thing to bound is not "how many requests arrive" but "how many
 * conversions run at once". Past that bound, extra work does not go faster - it
 * makes every request slower and eventually pushes all of them past the
 * client's 120s abort, which turns a busy server into a server that looks
 * broken.
 *
 * So: a fixed number of slots, a short waiting room, and an honest 503 E_BUSY
 * for everything beyond that. A prompt "try again in a moment" is a far better
 * answer than a request that hangs for two minutes and then dies.
 */
import { Errors } from './errors.ts';

export interface QueueStats {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

export class BoundedQueue {
  private running = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort?: () => void;
    signal?: AbortSignal;
  }> = [];

  private readonly maxConcurrent: number;
  private readonly maxQueued: number;

  // Written out longhand rather than as constructor parameter properties,
  // which Node's strip-only TypeScript mode rejects.
  constructor(maxConcurrent: number, maxQueued: number) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
  }

  stats(): QueueStats {
    return {
      running: this.running,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  /**
   * Is there room for another request?
   *
   * Used to shed load BEFORE reading the body, so a client is told the
   * converter is busy instead of spending a minute uploading 25MB to find out.
   * Advisory only - `acquire` is what actually decides, since the answer can
   * change between this call and that one.
   */
  hasCapacity(): boolean {
    return this.running < this.maxConcurrent || this.waiters.length < this.maxQueued;
  }

  /**
   * Run `fn` once a slot is free.
   *
   * The slot is released even if `fn` throws, and a request that is still
   * waiting when its client disconnects is removed from the queue rather than
   * being handed a slot nobody wants.
   */
  async run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    // A slot is free: take it immediately, never touching the waiting room.
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return Promise.resolve(this.makeRelease());
    }

    // Waiting room is full. Shed the load now, while we can still answer
    // quickly, instead of letting the request rot in a queue it will time out of.
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(Errors.busy());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number];

      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.waiters.shift();
      if (next) {
        // Hand the slot straight to the next waiter: running stays constant.
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        next.resolve(this.makeRelease());
      } else {
        this.running -= 1;
      }
    };
  }
}

/**
 * A fixed-window per-IP request limiter.
 *
 * This endpoint is unauthenticated and cannot be anything else - the client is
 * an APK, so any secret shipped inside it is public. That means the only
 * available defence against casual abuse is to charge per IP and cap how much
 * work one source can ask for. It is deliberately simple: it exists to blunt
 * accidental or lazy floods, not to stop a determined attacker with a botnet,
 * which is a job for the proxy in front.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(maxPerWindow: number, windowMs: number) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  /** Returns true when the request is allowed. */
  check(key: string, now = Date.now()): boolean {
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.maybeSweep(now);
      return true;
    }
    existing.count += 1;
    return existing.count <= this.maxPerWindow;
  }

  /** Keeps the map from growing with one entry per IP we have ever seen. */
  private maybeSweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key);
    }
  }
}

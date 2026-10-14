import { ProviderError } from '../errors.js';

export interface RequestQueueOptions {
  concurrency: number;
  /** Minimum spacing between request starts. */
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Limits concurrency and request rate, dedupes identical in-flight keys, and supports a cooldown after upstream throttling. */
export class RequestQueue {
  cooldownUntil = 0;
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  private nextStart = -Infinity;

  constructor(opts: RequestQueueOptions) {
    this.concurrency = Math.max(1, opts.concurrency);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    if (this.coolingDown()) return Promise.reject(this.cooldownError());
    const p = this.execute(fn).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Reject new work until `now() + ms` (never shortens an existing cooldown). */
  backoff(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms);
  }

  private coolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  private cooldownError(): ProviderError {
    return new ProviderError('queue', 'cooling down', true);
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Reserve a start slot synchronously so concurrent tasks are spaced apart.
      const now = this.now();
      const startAt = Math.max(now, this.nextStart);
      this.nextStart = startAt + this.minIntervalMs;
      if (startAt > now) await this.sleep(startAt - now);
      if (this.coolingDown()) throw this.cooldownError();
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over directly
    else this.active--;
  }
}

import { describe, expect, it } from 'vitest';
import { RequestQueue } from '../../src/providers/queue.js';
import { ProviderError } from '../../src/errors.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    sleeps,
  };
}

describe('RequestQueue', () => {
  it('concurrency 1 serializes calls', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const d1 = deferred<void>();
    const task = (name: string, gate?: Promise<void>) => async () => {
      running++; maxRunning = Math.max(maxRunning, running); order.push(`start ${name}`);
      if (gate) await gate;
      order.push(`end ${name}`); running--;
      return name;
    };
    const p1 = q.run('a', task('a', d1.promise));
    const p2 = q.run('b', task('b'));
    await tick();
    expect(order).toEqual(['start a']);
    d1.resolve();
    expect(await Promise.all([p1, p2])).toEqual(['a', 'b']);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(maxRunning).toBe(1);
  });

  it('allows up to `concurrency` tasks at once', async () => {
    const q = new RequestQueue({ concurrency: 2, minIntervalMs: 0 });
    let running = 0;
    let maxRunning = 0;
    const gate = deferred<void>();
    const task = async () => { running++; maxRunning = Math.max(maxRunning, running); await gate.promise; running--; };
    const all = Promise.all(['a', 'b', 'c'].map((k) => q.run(k, task)));
    await tick();
    expect(running).toBe(2);
    gate.resolve();
    await all;
    expect(maxRunning).toBe(2);
  });

  it('same-key concurrent calls invoke fn once and share the result', async () => {
    const q = new RequestQueue({ concurrency: 2, minIntervalMs: 0 });
    let calls = 0;
    const d = deferred<number>();
    const fn = () => { calls++; return d.promise; };
    const p1 = q.run('k', fn);
    const p2 = q.run('k', fn);
    expect(p2).toBe(p1);
    d.resolve(42);
    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
    expect(calls).toBe(1);
    // once settled, the key can run again
    await q.run('k', async () => { calls++; });
    expect(calls).toBe(2);
  });

  it('a rejected in-flight key is released for later calls', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    await expect(q.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await q.run('k', async () => 'ok')).toBe('ok');
  });

  it('respects minIntervalMs spacing between request starts using fake now/sleep', async () => {
    // Virtual timers: sleep() resolves only when the test advances the clock to its deadline.
    let t = 1_000_000;
    const timers: { at: number; resolve: () => void }[] = [];
    const sleeps: number[] = [];
    const now = () => t;
    const sleep = (ms: number) => { sleeps.push(ms); return new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })); };
    const runTimers = async () => {
      for (;;) {
        await tick();
        if (timers.length === 0) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.resolve();
      }
    };
    const q = new RequestQueue({ concurrency: 3, minIntervalMs: 500, now, sleep });
    const starts: number[] = [];
    const fn = async () => { starts.push(now()); };
    const all = Promise.all([q.run('a', fn), q.run('b', fn), q.run('c', fn)]);
    await runTimers();
    await all;
    expect(starts).toEqual([1_000_000, 1_000_500, 1_001_000]);
    // after enough idle time no sleep is needed
    t += 10_000;
    const before = sleeps.length;
    await q.run('d', fn);
    expect(sleeps.length).toBe(before);
    expect(starts.at(-1)).toBe(1_011_000);
  });

  it('after backoff(1000) run rejects with a retryable ProviderError until time advances', async () => {
    const clock = fakeClock();
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    q.backoff(1000);
    expect(q.cooldownUntil).toBe(clock.now() + 1000);
    let called = false;
    const fn = async () => { called = true; return 'ok'; };
    const err = await q.run('x', fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).provider).toBe('queue');
    expect(called).toBe(false);
    clock.advance(999);
    await expect(q.run('x', fn)).rejects.toBeInstanceOf(ProviderError);
    clock.advance(1);
    expect(await q.run('x', fn)).toBe('ok');
    expect(called).toBe(true);
  });

  it('backoff never shortens an existing cooldown', () => {
    const clock = fakeClock();
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    q.backoff(5000);
    q.backoff(1000);
    expect(q.cooldownUntil).toBe(clock.now() + 5000);
  });
});

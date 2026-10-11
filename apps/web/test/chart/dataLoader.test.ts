import type { Bar, BarsResponse, LatestResponse, SessionMode } from '@altv/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BarsParams, LatestParams } from '../../src/api/client';
import { createDataLoader, type LoaderEvents } from '../../src/chart/dataLoader';
import { forwardRetryWindowMs, initialWindowMs } from '../../src/chart/periods';

const NOW = Date.UTC(2026, 9, 9, 15, 0);
const MIN5 = 5 * 60_000;
const symbol = { ticker: 'stock:AAPL' };
const period5m = { type: 'minute', span: 5 };

function bar(ts: number, extra: Partial<Bar> = {}): Bar {
  return { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, ...extra };
}
function barsRes(bars: Bar[], over: Partial<BarsResponse> = {}): BarsResponse {
  return { symbol: 'stock:AAPL', tf: '5m', session: 'eth', bars, hasMoreBefore: true, stale: false, notices: [], markers: [], ...over };
}

function setup(opts: { session?: () => SessionMode; pollMs?: number } = {}) {
  const fetchBars = vi.fn<(p: BarsParams, signal?: AbortSignal) => Promise<BarsResponse>>();
  const fetchLatest = vi.fn<(p: LatestParams, signal?: AbortSignal) => Promise<LatestResponse>>();
  const events: LoaderEvents = { onMeta: vi.fn(), onError: vi.fn() };
  const loader = createDataLoader({
    session: opts.session ?? (() => 'eth'),
    pollMs: opts.pollMs ?? 5000,
    now: () => NOW,
    fetchBars,
    fetchLatest,
  }, events);
  return { loader, fetchBars, fetchLatest, events };
}

async function init(loader: ReturnType<typeof setup>['loader'], period = period5m) {
  const callback = vi.fn();
  await loader.getBars({ type: 'init', timestamp: null, symbol, period, callback });
  return callback;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createDataLoader getBars', () => {
  it('init requests [now − initialWindow, now) and maps fields to KLineData', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([bar(NOW - 2 * MIN5, { session: 'pre' }), bar(NOW - MIN5, { session: 'regular' })]));
    const cb = await init(loader);
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect(fetchBars.mock.calls[0]![0]).toEqual({
      symbol: 'stock:AAPL', tf: '5m', session: 'eth', from: NOW - initialWindowMs('5m'), to: NOW,
    });
    expect(cb).toHaveBeenCalledWith(
      [
        { timestamp: NOW - 2 * MIN5, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, session: 'pre' },
        { timestamp: NOW - MIN5, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, session: 'regular' },
      ],
      { forward: true, backward: false },
    );
  });

  it('more.forward mirrors hasMoreBefore', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([bar(NOW - MIN5)], { hasMoreBefore: false }));
    const cb = await init(loader);
    expect(cb.mock.calls[0]![1]).toEqual({ forward: false, backward: false });
  });

  it('emits meta (stale, notices, markers) after init', async () => {
    const { loader, fetchBars, events } = setup();
    const markers = [{ ts: NOW - 3 * MIN5, label: 'v2' }];
    fetchBars.mockResolvedValue(barsRes([bar(NOW - MIN5)], { stale: true, notices: ['n1'], markers }));
    await init(loader);
    expect(events.onMeta).toHaveBeenLastCalledWith({ stale: true, notices: ['n1'], markers });
  });

  it('forward uses timestamp as `to` and from = to − initialWindow', async () => {
    const { loader, fetchBars } = setup();
    const t0 = NOW - 1000 * MIN5;
    fetchBars.mockResolvedValue(barsRes([bar(t0 - MIN5)]));
    const cb = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: t0, symbol, period: period5m, callback: cb });
    expect(fetchBars.mock.calls[0]![0]).toMatchObject({ from: t0 - initialWindowMs('5m'), to: t0 });
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ timestamp: t0 - MIN5 })], { forward: true, backward: false });
  });

  it('empty forward with hasMoreBefore retries once with a wider (4×, capped) window', async () => {
    const { loader, fetchBars } = setup();
    const t0 = NOW - 1000 * MIN5;
    fetchBars
      .mockResolvedValueOnce(barsRes([], { hasMoreBefore: true }))
      .mockResolvedValueOnce(barsRes([bar(t0 - 10 * 86_400_000)], { hasMoreBefore: true }));
    const cb = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: t0, symbol, period: period5m, callback: cb });
    expect(fetchBars).toHaveBeenCalledTimes(2);
    expect(fetchBars.mock.calls[1]![0]).toMatchObject({ from: t0 - forwardRetryWindowMs('5m'), to: t0 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toHaveLength(1);
    expect(cb.mock.calls[0]![1]).toEqual({ forward: true, backward: false });
  });

  it('gives up (forward: false) when the retry is still empty', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([], { hasMoreBefore: true }));
    const cb = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: NOW - MIN5, symbol, period: period5m, callback: cb });
    expect(fetchBars).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith([], { forward: false, backward: false });
  });

  it('empty init with hasMoreBefore (e.g. 1m over a weekend) retries once with the wider window', async () => {
    const { loader, fetchBars } = setup();
    fetchBars
      .mockResolvedValueOnce(barsRes([], { hasMoreBefore: true }))
      .mockResolvedValueOnce(barsRes([bar(NOW - 3 * 86_400_000)], { hasMoreBefore: true }));
    const cb = await init(loader, { type: 'minute', span: 1 });
    expect(fetchBars).toHaveBeenCalledTimes(2);
    expect(fetchBars.mock.calls[1]![0]).toMatchObject({ tf: '1m', from: NOW - forwardRetryWindowMs('1m'), to: NOW });
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ timestamp: NOW - 3 * 86_400_000 })], { forward: true, backward: false });
  });

  it('never reports more older data after an empty result (no load loop on an empty chart)', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([], { hasMoreBefore: true }));
    const cb = await init(loader);
    expect(cb).toHaveBeenCalledWith([], { forward: false, backward: false });
  });

  it('does not retry an empty forward without hasMoreBefore', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([], { hasMoreBefore: false }));
    const cb = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: NOW - MIN5, symbol, period: period5m, callback: cb });
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith([], { forward: false, backward: false });
  });

  it('backward answers immediately with no data and no more', async () => {
    const { loader, fetchBars } = setup();
    const cb = vi.fn();
    await loader.getBars({ type: 'backward', timestamp: NOW, symbol, period: period5m, callback: cb });
    expect(fetchBars).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith([], { backward: false });
  });

  it('reads the session getter at call time', async () => {
    let session: SessionMode = 'rth';
    const { loader, fetchBars } = setup({ session: () => session });
    fetchBars.mockResolvedValue(barsRes([bar(NOW - MIN5)]));
    await init(loader);
    session = 'eth';
    await init(loader);
    expect(fetchBars.mock.calls[0]![0].session).toBe('rth');
    expect(fetchBars.mock.calls[1]![0].session).toBe('eth');
  });

  it('derives tf from the period', async () => {
    const { loader, fetchBars } = setup();
    fetchBars.mockResolvedValue(barsRes([]));
    await init(loader, { type: 'day', span: 1 });
    expect(fetchBars.mock.calls[0]![0]).toMatchObject({ tf: '1D', from: NOW - initialWindowMs('1D'), to: NOW });
  });

  it('forward error → onError and an empty page that keeps more.forward, so a later forward fetches again', async () => {
    const { loader, fetchBars, events } = setup();
    const t0 = NOW - 1000 * MIN5;
    fetchBars
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(barsRes([bar(t0 - MIN5)]));
    const cb1 = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: t0, symbol, period: period5m, callback: cb1 });
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(cb1).toHaveBeenCalledWith([], { forward: true, backward: false });
    const cb2 = vi.fn();
    await loader.getBars({ type: 'forward', timestamp: t0, symbol, period: period5m, callback: cb2 });
    expect(fetchBars).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledWith([expect.objectContaining({ timestamp: t0 - MIN5 })], { forward: true, backward: false });
  });

  it('init error → onError, retries after 2 s and calls back on success', async () => {
    const { loader, fetchBars, events } = setup();
    fetchBars
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(barsRes([bar(NOW - MIN5)]));
    const cb = vi.fn();
    const done = loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchBars).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(fetchBars).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ timestamp: NOW - MIN5 })], { forward: true, backward: false });
  });

  it('init retries back off 2 s, 5 s, 10 s, then every 30 s, reporting each error', async () => {
    const { loader, fetchBars, events } = setup();
    fetchBars.mockRejectedValue(new Error('down'));
    void loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: vi.fn() });
    const calls = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); return fetchBars.mock.calls.length; };
    expect(await calls(0)).toBe(1);
    expect(await calls(2000)).toBe(2);
    expect(await calls(4999)).toBe(2);
    expect(await calls(1)).toBe(3);
    expect(await calls(10_000)).toBe(4);
    expect(await calls(29_999)).toBe(4);
    expect(await calls(1)).toBe(5);
    expect(await calls(30_000)).toBe(6);
    expect(events.onError).toHaveBeenCalledTimes(6);
    loader.dispose();
  });

  it('init retries stop after dispose, unsubscribe/reset, or a newer init', async () => {
    for (const stop of ['dispose', 'unsubscribe', 'newInit'] as const) {
      const { loader, fetchBars } = setup();
      fetchBars.mockRejectedValueOnce(new Error('boom'));
      const cb = vi.fn();
      void loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb });
      await vi.advanceTimersByTimeAsync(0);
      const cb2 = vi.fn();
      if (stop === 'dispose') loader.dispose();
      else if (stop === 'unsubscribe') loader.unsubscribeBar();
      else {
        fetchBars.mockResolvedValueOnce(barsRes([bar(NOW - MIN5)]));
        await loader.getBars({ type: 'init', timestamp: null, symbol, period: { type: 'hour', span: 1 }, callback: cb2 });
      }
      fetchBars.mockResolvedValue(barsRes([bar(NOW - MIN5)]));
      const before = fetchBars.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchBars.mock.calls.length, stop).toBe(before);
      expect(cb, stop).not.toHaveBeenCalled();
      if (stop === 'newInit') expect(cb2).toHaveBeenCalledTimes(1);
    }
  });

  it('an AbortError is not reported as an error and is not retried', async () => {
    const { loader, fetchBars, events } = setup();
    fetchBars.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const cb = vi.fn();
    await loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb });
    await loader.getBars({ type: 'forward', timestamp: NOW - MIN5, symbol, period: period5m, callback: cb });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.onError).not.toHaveBeenCalled();
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale init response superseded by a newer init', async () => {
    const { loader, fetchBars } = setup();
    let resolveFirst!: (r: BarsResponse) => void;
    fetchBars
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(barsRes([bar(NOW - MIN5)]));
    const cb1 = vi.fn();
    const p1 = loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb1 });
    const cb2 = await init(loader, { type: 'hour', span: 1 });
    resolveFirst(barsRes([bar(NOW - 2 * MIN5)]));
    await p1;
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('dispose() makes pending and future loads no-ops', async () => {
    const { loader, fetchBars } = setup();
    let resolveFirst!: (r: BarsResponse) => void;
    fetchBars.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const cb = vi.fn();
    const p = loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb });
    loader.dispose();
    resolveFirst(barsRes([bar(NOW - MIN5)]));
    await p;
    await loader.getBars({ type: 'init', timestamp: null, symbol, period: period5m, callback: cb });
    expect(cb).not.toHaveBeenCalled();
    expect(fetchBars).toHaveBeenCalledTimes(1);
  });
});

describe('createDataLoader polling', () => {
  async function subscribed(pollMs = 5000) {
    const s = setup({ pollMs });
    s.fetchBars.mockResolvedValue(barsRes([bar(NOW - 2 * MIN5), bar(NOW - MIN5)]));
    await init(s.loader);
    const onBar = vi.fn();
    s.loader.subscribeBar({ symbol, period: period5m, callback: onBar });
    return { ...s, onBar };
  }

  it('polls latest every pollMs and calls back with the mapped bar', async () => {
    const { fetchLatest, onBar } = await subscribed(5000);
    fetchLatest.mockResolvedValue({ bar: bar(NOW - MIN5, { close: 9 }), stale: false });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchLatest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledWith({ symbol: 'stock:AAPL', tf: '5m', session: 'eth' }, expect.anything());
    expect(onBar).toHaveBeenCalledWith(expect.objectContaining({ timestamp: NOW - MIN5, close: 9 }));
    fetchLatest.mockResolvedValue({ bar: bar(NOW, { close: 10 }), stale: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(onBar).toHaveBeenLastCalledWith(expect.objectContaining({ timestamp: NOW, close: 10 }));
  });

  it('bar: null is "no update"; bars older than the last loaded bar are dropped', async () => {
    const { fetchLatest, onBar } = await subscribed();
    fetchLatest.mockResolvedValueOnce({ bar: null, stale: false });
    fetchLatest.mockResolvedValueOnce({ bar: bar(NOW - 5 * MIN5), stale: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(onBar).not.toHaveBeenCalled();
  });

  it('propagates stale meta from latest', async () => {
    const { fetchLatest, events } = await subscribed();
    fetchLatest.mockResolvedValue({ bar: null, stale: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.onMeta).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true }));
  });

  it('fetch error → onError and polling continues', async () => {
    const { fetchLatest, events, onBar } = await subscribed();
    fetchLatest.mockRejectedValueOnce(new Error('down'));
    fetchLatest.mockResolvedValueOnce({ bar: bar(NOW), stale: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'down' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onBar).toHaveBeenCalledWith(expect.objectContaining({ timestamp: NOW }));
  });

  it('unsubscribe stops polling', async () => {
    const { loader, fetchLatest } = await subscribed();
    fetchLatest.mockResolvedValue({ bar: null, stale: false });
    await vi.advanceTimersByTimeAsync(5000);
    loader.unsubscribeBar();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('uses the injected timer functions', async () => {
    const setTimer = vi.fn((_fn: () => void, _ms: number) => 42);
    const clearTimer = vi.fn();
    const loader = createDataLoader(
      { session: () => 'rth', pollMs: 1234, fetchBars: vi.fn(), fetchLatest: vi.fn(), setTimer, clearTimer },
      { onMeta: vi.fn(), onError: vi.fn() },
    );
    loader.subscribeBar({ symbol, period: period5m, callback: vi.fn() });
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1234);
    loader.unsubscribeBar();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});

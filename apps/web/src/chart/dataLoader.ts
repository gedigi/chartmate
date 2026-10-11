import type { Bar, BarsResponse, Marker, SessionMode, Timeframe } from '@altv/shared';
import { api } from '../api/client';
import { forwardRetryWindowMs, fromPeriod, initialWindowMs } from './periods';

/** Structurally identical to klinecharts' KLineData (kept local so this module stays klinecharts-free). */
export interface KLineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  turnover?: number;
  [key: string]: unknown;
}

export interface LoaderMeta { stale: boolean; notices: string[]; markers: Marker[] }

export interface LoaderEvents {
  onMeta(m: LoaderMeta): void;
  onError(e: Error): void;
}

export interface LoaderContext {
  /** Read at request time. */
  session: () => SessionMode;
  pollMs: number;
  now?: () => number;
  fetchBars?: typeof api.bars;
  fetchLatest?: typeof api.latest;
  /** Injectable for tests; default setInterval/clearInterval. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type More = { forward?: boolean; backward?: boolean };

export interface GetBarsParams {
  type: 'init' | 'forward' | 'backward' | 'update';
  timestamp: number | null;
  symbol: { ticker: string };
  period: { type: string; span: number };
  callback: (data: KLineData[], more?: More) => void;
}

export interface SubscribeBarParams {
  symbol: { ticker: string };
  period: { type: string; span: number };
  callback: (bar: KLineData) => void;
}

export interface DataLoaderImpl {
  getBars(p: GetBarsParams): Promise<void>;
  subscribeBar(p: SubscribeBarParams): void;
  unsubscribeBar(): void;
  /** Stops polling and turns every pending and future request into a no-op. */
  dispose(): void;
}

export function toKLineData(b: Bar): KLineData {
  const d: KLineData = { timestamp: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  if (b.session !== undefined) d.session = b.session;
  return d;
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

function mergeMarkers(a: Marker[], b: Marker[]): Marker[] {
  const seen = new Set(a.map((m) => `${m.ts}|${m.label}`));
  const out = [...a];
  for (const m of b) {
    const key = `${m.ts}|${m.label}`;
    if (!seen.has(key)) { seen.add(key); out.push(m); }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/** Backoff between failed initial loads: 2 s, 5 s, 10 s, then every 30 s. */
const INIT_RETRY_MS = [2000, 5000, 10_000];
const INIT_RETRY_MS_MAX = 30_000;

const mergeNotices = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/**
 * Implements KLineChart's DataLoader contract on top of /api/bars and /api/latest.
 * - 'init' loads [now − initialWindow, now); 'forward' (older data) loads [timestamp − initialWindow, timestamp),
 *   retrying once with a wider window when a page (initial or older) is empty but the server says more exists
 *   (listing gaps, weekends on short intraday windows). An empty result always reports no more older data.
 * - 'backward' (newer data) is answered empty: real-time updates come from polling via subscribeBar.
 * - Each 'init' starts a new generation; responses from an older generation are dropped.
 * - Errors (never AbortErrors) go to onError. A failed 'forward' page answers empty with more.forward kept, so the
 *   next scroll retries; a failed 'init' retries with backoff until it succeeds or is superseded (new init,
 *   unsubscribeBar/reset, dispose), because KLineChart stays "loading" until the callback runs.
 */
export function createDataLoader(ctx: LoaderContext, events: LoaderEvents): DataLoaderImpl {
  const now = ctx.now ?? Date.now;
  const fetchBars = ctx.fetchBars ?? ((p, s) => api.bars(p, s));
  const fetchLatest = ctx.fetchLatest ?? ((p, s) => api.latest(p, s));
  const setTimer = ctx.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = ctx.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  let gen = 0;
  let disposed = false;
  let lastTs = Number.NEGATIVE_INFINITY;
  let meta: LoaderMeta = { stale: false, notices: [], markers: [] };
  const inFlight = new Set<AbortController>();

  let timer: unknown = null;
  let subGen = 0;
  let polling: AbortController | null = null;

  /** Pending init-retry delays: timer → resolver (resolving early lets the waiting load exit). */
  const retryWaits = new Map<ReturnType<typeof setTimeout>, () => void>();

  function abortAll() {
    for (const c of inFlight) c.abort();
    inFlight.clear();
  }

  function cancelRetries() {
    for (const [t, resolve] of retryWaits) {
      clearTimeout(t);
      resolve();
    }
    retryWaits.clear();
  }

  /** Supersedes every pending load: their results are dropped and their retries stop. */
  function cancelLoads() {
    gen++;
    abortAll();
    cancelRetries();
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { retryWaits.delete(t); resolve(); }, ms);
      retryWaits.set(t, resolve);
    });
  }

  async function load(symbol: string, tf: Timeframe, from: number, to: number, signal: AbortSignal): Promise<BarsResponse> {
    return fetchBars({ symbol, tf, session: ctx.session(), from, to }, signal);
  }

  /** One page ending at `to`, retried once with a wider window when empty but more exists (listing gaps, weekends). */
  async function page(symbol: string, tf: Timeframe, to: number, signal: AbortSignal, current: () => boolean) {
    let res = await load(symbol, tf, to - initialWindowMs(tf), to, signal);
    let bars = res.bars.filter((b) => b.ts < to);
    if (current() && bars.length === 0 && res.hasMoreBefore) {
      res = await load(symbol, tf, to - forwardRetryWindowMs(tf), to, signal);
      bars = res.bars.filter((b) => b.ts < to);
    }
    return { res, bars };
  }

  async function getBars(p: GetBarsParams): Promise<void> {
    if (disposed) return;
    if (p.type === 'backward' || p.type === 'update') {
      p.callback([], { backward: false });
      return;
    }
    const isInit = p.type === 'init' || p.timestamp === null;
    if (isInit) cancelLoads();
    const myGen = gen;
    const ctrl = new AbortController();
    inFlight.add(ctrl);
    const current = () => !disposed && myGen === gen;
    try {
      const tf = fromPeriod(p.period);
      const symbol = p.symbol.ticker;
      let result: Awaited<ReturnType<typeof page>> | null = null;
      for (let attempt = 0; result === null; attempt++) {
        try {
          result = await page(symbol, tf, isInit ? now() : p.timestamp!, ctrl.signal, current);
        } catch (err) {
          if (!current() || isAbort(err)) return;
          events.onError(toError(err));
          if (!isInit) {
            // KLineChart stays "loading" until the callback runs. An empty page keeping more.forward
            // does not re-trigger a load, so the next scroll to the left edge retries.
            p.callback([], { forward: true, backward: false });
            return;
          }
          // Init must eventually succeed (it also starts polling): retry until superseded.
          await wait(INIT_RETRY_MS[attempt] ?? INIT_RETRY_MS_MAX);
          if (!current()) return;
        }
      }
      if (!current()) return;
      const { res, bars } = result;
      // After an empty page the next 'forward' request would reuse the same anchor, so stop there.
      const hasMore = bars.length > 0 && res.hasMoreBefore;
      if (isInit) {
        lastTs = bars.at(-1)?.ts ?? Number.NEGATIVE_INFINITY;
        meta = { stale: res.stale, notices: res.notices, markers: res.markers };
      } else {
        meta = { stale: res.stale, notices: mergeNotices(meta.notices, res.notices), markers: mergeMarkers(meta.markers, res.markers) };
      }
      p.callback(bars.map(toKLineData), { forward: hasMore, backward: false });
      events.onMeta(meta);
    } finally {
      inFlight.delete(ctrl);
    }
  }

  function stopPolling(): void {
    subGen++;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    polling?.abort();
    polling = null;
  }

  /** Called by KLineChart on reset (symbol/period/loader change): stops polling and cancels pending loads. */
  function unsubscribeBar(): void {
    stopPolling();
    cancelLoads();
  }

  function subscribeBar(p: SubscribeBarParams): void {
    stopPolling();
    if (disposed) return;
    const mySub = subGen;
    const symbol = p.symbol.ticker;
    const tf = fromPeriod(p.period);
    const tick = () => {
      if (polling) return; // previous poll still in flight
      const ctrl = new AbortController();
      polling = ctrl;
      fetchLatest({ symbol, tf, session: ctx.session() }, ctrl.signal).then(
        (res) => {
          if (disposed || mySub !== subGen) return;
          if (res.stale !== meta.stale) {
            meta = { ...meta, stale: res.stale };
            events.onMeta(meta);
          }
          // bar: null is normal outside market hours → no update. Never move backwards.
          if (res.bar && res.bar.ts >= lastTs) {
            lastTs = res.bar.ts;
            p.callback(toKLineData(res.bar));
          }
        },
        (err: unknown) => {
          if (disposed || mySub !== subGen || isAbort(err)) return;
          events.onError(toError(err));
        },
      ).finally(() => { if (polling === ctrl) polling = null; });
    };
    timer = setTimer(tick, ctx.pollMs);
  }

  function dispose(): void {
    disposed = true;
    stopPolling();
    cancelLoads();
  }

  return { getBars, subscribeBar, unsubscribeBar, dispose };
}

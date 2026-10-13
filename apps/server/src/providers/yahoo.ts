import YahooFinance from 'yahoo-finance2';
import {
  nyDateUtcMidnight, nyParts, nyToUtc, pctChange, tagSessions, tfMs,
  type Bar, type NativeTimeframe, type Quote, type QuoteExt, type Session, type SessionWindow, type SymbolInfo,
} from '@altv/shared';
import { NotFoundError, ProviderError } from '../errors.js';
import { errMessage, REQUEST_TIMEOUT_MS } from './http.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits, StockSplit } from './types.js';

/** The subset of yahoo-finance2 we use; injectable so tests can feed recorded fixtures. */
export interface YahooLike {
  chart(sym: string, opts: Record<string, unknown>): Promise<any>;
  search(q: string, opts: Record<string, unknown>): Promise<any>;
  quote(syms: string[], opts?: Record<string, unknown>): Promise<any>;
}

/** Wraps yahoo-finance2; every call gets its own request timeout so a stalled request can't hold a queue slot. */
export function createYahooClient(yf: any = new YahooFinance({ suppressNotices: ['yahooSurvey'] })): YahooLike {
  // yahoo-finance2's overloaded signatures don't fit a plain structural interface, hence `any`.
  const moduleOptions = () => ({ fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } });
  return {
    chart: (sym, opts) => yf.chart(sym, opts, moduleOptions()),
    search: (q, opts) => yf.search(q, opts, moduleOptions()),
    quote: (syms, opts) => yf.quote(syms, opts ?? {}, moduleOptions()),
  };
}

const DAY = 86_400_000;
const MIN = 60_000;
const INTERVAL: Record<NativeTimeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1D': '1d' };
const OFF_GRID_MOD_MAX = 30 * MIN;

type DateLike = Date | string | number;
interface YQuote { date: DateLike; open: number | null; high: number | null; low: number | null; close: number | null; volume?: number | null }
interface YPeriod { start: DateLike; end: DateLike }
interface YSplit { date: DateLike; splitRatio?: string; numerator?: number; denominator?: number }
interface YChart {
  events?: { splits?: YSplit[] | Record<string, YSplit> };
  meta?: { firstTradeDate?: DateLike | null; tradingPeriods?: Partial<Record<Session, YPeriod[][] | YPeriod[]>> };
  quotes?: YQuote[];
}

export interface YahooOptions { client: YahooLike; now?: () => number }

export class YahooProvider implements MarketDataProvider {
  readonly id = 'yahoo' as const;
  readonly assetClass = 'stock' as const;
  readonly limits: ProviderLimits = {
    maxLookbackMs: { '1m': 29 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 729 * DAY },
    maxSpanPerRequestMs: { '1m': 7 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 729 * DAY },
  };
  private readonly client: YahooLike;
  private readonly now: () => number;

  constructor(opts: YahooOptions) {
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
  }

  async fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult> {
    const now = this.now();
    const lookback = this.limits.maxLookbackMs[tf];
    const start = lookback === undefined ? from : Math.max(from, now - lookback);
    const end = Math.min(to, now);
    if (start >= end) return { bars: [] };

    const daily = tf === '1D';
    const span = this.limits.maxSpanPerRequestMs[tf] ?? Infinity;
    // 1m–30m bars sit on their own grid; 1h bars start at :30 (09:30 NY), so check those against 30m.
    const gridMod = Math.min(tfMs(tf), OFF_GRID_MOD_MAX);
    const byTs = new Map<number, Bar>();
    const windows: SessionWindow[] = [];
    let firstTs: number | null = null;

    for (let s = start; s < end; s = s + span) {
      const e = Math.min(end, s + span);
      // Daily bars are stamped at the 09:30 NY open (13:30Z/14:30Z), not at midnight: ask one day past the
      // chunk end so the last day's bar is returned, then keep [from, to) on the normalized ts below.
      const period2 = daily ? Math.min(e + DAY, now) : e;
      const opts: Record<string, unknown> = { period1: new Date(s), period2: new Date(period2), interval: INTERVAL[tf] };
      if (!daily) opts.includePrePost = true;
      const res = (await this.call(() => this.client.chart(code, opts))) as YChart;

      const ftd = toMs(res.meta?.firstTradeDate);
      if (ftd !== null) firstTs = nyDateUtcMidnight(ftd);
      if (!daily && res.meta?.tradingPeriods) windows.push(...windowsFromRegular(res.meta.tradingPeriods));
      for (const q of res.quotes ?? []) {
        const bar = toBar(q);
        if (!bar) continue;
        if (daily) bar.ts = nyDateUtcMidnight(bar.ts);
        else if (bar.ts % gridMod !== 0) continue; // Yahoo's trailing off-grid "live tick" pseudo-bar
        if (bar.ts < from || bar.ts >= to) continue;
        byTs.set(bar.ts, bar); // duplicates: the last occurrence wins
      }
    }

    const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    if (daily) return { bars: sorted, firstTs };
    const sessionWindows = windows.length > 0 ? dedupeWindows(windows) : undefined;
    return { bars: tagSessions(sorted, sessionWindows), firstTs, ...(sessionWindows ? { sessionWindows } : {}) };
  }

  async search(q: string): Promise<SymbolInfo[]> {
    const res = await this.call(() => this.client.search(q, { quotesCount: 20, newsCount: 0 }));
    const out: SymbolInfo[] = [];
    for (const r of (res?.quotes ?? []) as Record<string, any>[]) {
      const symbol = r.symbol;
      if (!r.isYahooFinance || typeof symbol !== 'string') continue;
      if (r.quoteType !== 'EQUITY' && r.quoteType !== 'ETF') continue;
      if (/[.=^]/.test(symbol)) continue;
      out.push({
        id: `stock:${symbol}`, assetClass: 'stock', ticker: symbol,
        name: r.shortname ?? r.longname ?? symbol,
        ...(r.exchange ? { exchange: r.exchange } : {}),
        pricePrecision: 2,
      });
    }
    return out.slice(0, 20);
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return [];
    const res = await this.call(() => this.client.quote(codes));
    const rows = (Array.isArray(res) ? res : [res]) as Record<string, any>[];
    const out: Quote[] = [];
    for (const r of rows) {
      if (!r || typeof r.symbol !== 'string') continue;
      // price/changePct/ts are always the REGULAR session pair (in PRE: the previous session's close and its move).
      const price: unknown = r.regularMarketPrice; // isNum rejects null/NaN/non-numbers
      const ts = toMs(r.regularMarketTime);
      if (!isNum(price) || ts === null) continue;
      const changePct = isNum(r.regularMarketChangePercent)
        ? r.regularMarketChangePercent
        : isNum(r.regularMarketPreviousClose) ? pctChange(price, r.regularMarketPreviousClose) : null;
      const ext = extendedQuote(r, price, ts);
      out.push({ id: `stock:${r.symbol}`, price, changePct, ts, ...(ext ? { ext } : {}) });
    }
    return out;
  }

  async firstBarTs(code: string): Promise<number | null> {
    const res = (await this.call(() => this.client.chart(code, { period1: new Date(this.now() - 7 * DAY), interval: '1d' }))) as YChart;
    const ftd = toMs(res.meta?.firstTradeDate);
    return ftd === null ? null : nyDateUtcMidnight(ftd);
  }

  /** Splits after `since`, from a chart call with split events (yahoo-finance2 `events: 'split'`). */
  async splitsSince(code: string, since: number): Promise<StockSplit[]> {
    // A coarse interval keeps the payload small; the split events are reported regardless of the bar interval.
    const opts = { period1: new Date(since), period2: new Date(this.now()), interval: '3mo', events: 'split' };
    const res = (await this.call(() => this.client.chart(code, opts))) as YChart;
    const raw = res.events?.splits;
    const list = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
    const out: StockSplit[] = [];
    for (const sp of list) {
      const ts = toMs(sp.date);
      if (ts === null || ts <= since) continue;
      const factor = isNum(sp.numerator) && isNum(sp.denominator) && sp.numerator > 0 && sp.denominator > 0
        ? sp.numerator / sp.denominator : undefined;
      out.push({
        ts,
        ...(typeof sp.splitRatio === 'string' ? { ratio: sp.splitRatio } : {}),
        ...(factor !== undefined ? { factor } : {}),
      });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapYahooError(err);
    }
  }
}

function mapYahooError(err: unknown): Error {
  if (err instanceof NotFoundError || err instanceof ProviderError) return err;
  const msg = errMessage(err);
  const code = (err as { code?: unknown } | null)?.code;
  const status = typeof code === 'number' ? code : undefined;
  if (status === 404 || /no data found|delisted/i.test(msg)) return new NotFoundError(`yahoo: ${msg}`);
  if (status === 429 || /too many requests/i.test(msg)) return new ProviderError('yahoo', msg, true, 429);
  if (status !== undefined && status >= 500) return new ProviderError('yahoo', msg, true, status);
  if (isNetworkError(err)) return new ProviderError('yahoo', `request failed: ${msg}`, true);
  return new ProviderError('yahoo', msg, false, status);
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof causeCode === 'string' && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(causeCode);
}

type ExtFields = { session: 'pre' | 'post'; price: string; time: string };
const PRE_FIELDS: ExtFields = { session: 'pre', price: 'preMarketPrice', time: 'preMarketTime' };
const POST_FIELDS: ExtFields = { session: 'post', price: 'postMarketPrice', time: 'postMarketTime' };
/** Extended-hours field sets to try, in order, per Yahoo marketState (REGULAR/CLOSED: none). */
const EXT_FIELDS: Record<string, ExtFields[]> = {
  // From 04:00 until the first pre-market trade, the latest extended print is still the evening's post one.
  PRE: [PRE_FIELDS, POST_FIELDS],
  POST: [POST_FIELDS],
  POSTPOST: [POST_FIELDS],
  // Overnight before the pre-market opens: likewise the evening's post print.
  PREPRE: [POST_FIELDS],
};

/**
 * The extended-hours price with its change vs the latest regular close (`regularPrice`, stamped `regularTs`).
 * Yahoo keeps stale pre/post fields around, so the print must be finite, positive and later than the end of that
 * regular session: 16:00 NY on its date (DST-aware), or the regular time itself when earlier (early closes). The
 * close is sometimes restamped after 16:00, which must not hide post prints made in between.
 */
function extendedQuote(r: Record<string, any>, regularPrice: number, regularTs: number): QuoteExt | undefined {
  const { y, m, d } = nyParts(regularTs);
  const sessionEnd = Math.min(regularTs, nyToUtc(y, m, d, 16, 0));
  for (const f of EXT_FIELDS[r.marketState as string] ?? []) {
    const price: unknown = r[f.price];
    const ts = toMs(r[f.time]);
    if (!isNum(price) || price <= 0 || ts === null || ts <= sessionEnd) continue;
    const changePct = pctChange(price, regularPrice);
    if (changePct !== null) return { session: f.session, price, changePct, ts };
  }
  return undefined;
}

function toBar(q: YQuote): Bar | null {
  const ts = toMs(q.date);
  const { open, high, low, close } = q;
  if (ts === null || !isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) return null;
  return { ts, open, high, low, close, volume: isNum(q.volume) ? q.volume : 0 };
}

/**
 * Builds windows from each day's `regular` period only: pre = [04:00 NY, open), regular = [open, close),
 * post = [close, 20:00 NY). Yahoo's own pre/post periods are ignored, since they need not start exactly at an
 * early close. Days without a regular period get no windows, so their bars fall back to fixed hours.
 */
function windowsFromRegular(tp: Partial<Record<Session, YPeriod[][] | YPeriod[]>>): SessionWindow[] {
  const out: SessionWindow[] = [];
  for (const p of (tp.regular ?? []).flat()) {
    const start = toMs(p.start);
    const end = toMs(p.end);
    if (start === null || end === null || end <= start) continue;
    const { y, m, d } = nyParts(start);
    const preStart = nyToUtc(y, m, d, 4, 0);
    const postEnd = nyToUtc(y, m, d, 20, 0);
    if (preStart < start) out.push({ start: preStart, end: start, session: 'pre' });
    out.push({ start, end, session: 'regular' });
    if (end < postEnd) out.push({ start: end, end: postEnd, session: 'post' });
  }
  return out;
}

function dedupeWindows(ws: SessionWindow[]): SessionWindow[] {
  const seen = new Map<string, SessionWindow>();
  for (const w of ws) seen.set(`${w.start}:${w.end}:${w.session}`, w);
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

function toMs(x: DateLike | null | undefined): number | null {
  if (x === null || x === undefined) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

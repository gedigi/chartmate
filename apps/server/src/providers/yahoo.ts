import YahooFinance from 'yahoo-finance2';
import {
  nyDateUtcMidnight, tagSessions,
  type Bar, type NativeTimeframe, type Quote, type Session, type SessionWindow, type SymbolInfo,
} from '@altv/shared';
import { NotFoundError, ProviderError } from '../errors.js';
import { errMessage } from './http.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from './types.js';

/** The subset of yahoo-finance2 we use; injectable so tests can feed recorded fixtures. */
export interface YahooLike {
  chart(sym: string, opts: Record<string, unknown>): Promise<any>;
  search(q: string, opts: Record<string, unknown>): Promise<any>;
  quote(syms: string[], opts?: Record<string, unknown>): Promise<any>;
}

export function createYahooClient(): YahooLike {
  // yahoo-finance2's overloaded signatures don't fit a plain structural interface.
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] }) as any;
  return {
    chart: (sym, opts) => yf.chart(sym, opts),
    search: (q, opts) => yf.search(q, opts),
    quote: (syms, opts) => yf.quote(syms, opts),
  };
}

const DAY = 86_400_000;
const MIN = 60_000;
const INTERVAL: Record<NativeTimeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1D': '1d' };
const SESSIONS: Session[] = ['pre', 'regular', 'post'];

type DateLike = Date | string | number;
interface YQuote { date: DateLike; open: number | null; high: number | null; low: number | null; close: number | null; volume?: number | null }
interface YPeriod { start: DateLike; end: DateLike }
interface YChart {
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
    const byTs = new Map<number, Bar>();
    const windows: SessionWindow[] = [];
    let sawPeriods = false;
    let firstTs: number | null = null;

    for (let s = start; s < end; s = s + span) {
      const e = Math.min(end, s + span);
      const opts: Record<string, unknown> = { period1: new Date(s), period2: new Date(e), interval: INTERVAL[tf] };
      if (!daily) opts.includePrePost = true;
      const res = (await this.call(() => this.client.chart(code, opts))) as YChart;

      const ftd = toMs(res.meta?.firstTradeDate);
      if (ftd !== null) firstTs = nyDateUtcMidnight(ftd);
      if (!daily && res.meta?.tradingPeriods) {
        sawPeriods = true;
        windows.push(...periodsToWindows(res.meta.tradingPeriods));
      }
      for (const q of res.quotes ?? []) {
        const bar = toBar(q);
        if (!bar) continue;
        if (daily) bar.ts = nyDateUtcMidnight(bar.ts);
        else if (bar.ts % MIN !== 0) continue; // Yahoo's trailing off-grid "live tick" pseudo-bar
        if (bar.ts < from || bar.ts >= to) continue;
        byTs.set(bar.ts, bar); // duplicates: the last occurrence wins
      }
    }

    const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    if (daily) return { bars: sorted, firstTs };
    const sessionWindows = sawPeriods ? dedupeWindows(windows) : undefined;
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
      const state = r.marketState;
      let price: unknown = r.regularMarketPrice;
      if ((state === 'POST' || state === 'POSTPOST') && isNum(r.postMarketPrice)) price = r.postMarketPrice;
      else if (state === 'PRE' && isNum(r.preMarketPrice)) price = r.preMarketPrice;
      const ts = toMs(r.regularMarketTime);
      if (!isNum(price) || ts === null) continue;
      out.push({
        id: `stock:${r.symbol}`, price,
        changePct: isNum(r.regularMarketChangePercent) ? r.regularMarketChangePercent : null,
        ts,
      });
    }
    return out;
  }

  async firstBarTs(code: string): Promise<number | null> {
    const res = (await this.call(() => this.client.chart(code, { period1: new Date(this.now() - 7 * DAY), interval: '1d' }))) as YChart;
    const ftd = toMs(res.meta?.firstTradeDate);
    return ftd === null ? null : nyDateUtcMidnight(ftd);
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

function toBar(q: YQuote): Bar | null {
  const ts = toMs(q.date);
  const { open, high, low, close } = q;
  if (ts === null || !isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) return null;
  return { ts, open, high, low, close, volume: isNum(q.volume) ? q.volume : 0 };
}

function periodsToWindows(tp: Partial<Record<Session, YPeriod[][] | YPeriod[]>>): SessionWindow[] {
  const out: SessionWindow[] = [];
  for (const session of SESSIONS) {
    for (const p of (tp[session] ?? []).flat()) {
      const start = toMs(p.start);
      const end = toMs(p.end);
      if (start !== null && end !== null && end > start) out.push({ start, end, session });
    }
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

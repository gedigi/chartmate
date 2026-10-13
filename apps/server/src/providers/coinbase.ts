import { resample, tfMs, type Bar, type NativeTimeframe, type Quote, type SymbolInfo } from '@altv/shared';
import { NotFoundError, ProviderError } from '../errors.js';
import { getJson } from './http.js';
import { decimalsOf, num, rankMatches } from './util.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from './types.js';

const BASE_URL = 'https://api.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'altv', Accept: 'application/json' };
const MAX_CANDLES = 300;
const PRODUCTS_TTL_MS = 3_600_000;
const DAY = 86_400_000;
const HALF_HOUR = 30 * 60_000;

/** Granularity in seconds; 30m is not native (built from 5m). */
const GRANULARITY: Record<Exclude<NativeTimeframe, '30m'>, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 };

/** [time(s), low, high, open, close, volume] */
type Candle = [number, number, number, number, number, number];
interface Product { id: string; base_currency: string; quote_currency: string; status: string; trading_disabled?: boolean; quote_increment?: string }
interface Stats { last: string }

export interface CoinbaseOptions { fetchImpl?: typeof fetch; now?: () => number; baseUrl?: string }

export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase' as const;
  readonly assetClass = 'crypto' as const;
  /**
   * One candles request (≤ 300) per chunk, so MarketDataService paces requests through the queue and persists
   * each; 30m is built from 5m candles, so its span is 300 × 5m (a multiple of 30m).
   */
  readonly limits: ProviderLimits = {
    maxLookbackMs: {},
    maxSpanPerRequestMs: {
      '1m': MAX_CANDLES * tfMs('1m'), '5m': MAX_CANDLES * tfMs('5m'), '15m': MAX_CANDLES * tfMs('15m'),
      '30m': MAX_CANDLES * tfMs('5m'), '1h': MAX_CANDLES * tfMs('1h'), '1D': MAX_CANDLES * tfMs('1D'),
    },
  };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private products: { at: number; symbols: SymbolInfo[] } | null = null;
  /** Previous daily close per code for the UTC day `day` (floor(now / DAY)). */
  private readonly prevDaily = new Map<string, { day: number; close: number | null }>();

  constructor(opts: CoinbaseOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, '');
  }

  async fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult> {
    if (tf !== '30m') return { bars: await this.candles(code, GRANULARITY[tf], from, to) };
    // Fetch whole 30m buckets of 5m candles, aggregate on the UTC grid, then trim to [from, to).
    const start = Math.floor(from / HALF_HOUR) * HALF_HOUR;
    const end = Math.ceil(to / HALF_HOUR) * HALF_HOUR;
    const fine = await this.candles(code, GRANULARITY['5m'], start, end);
    const bars = resample(fine, '30m', 'utc')
      .filter((b) => b.ts >= from && b.ts < to)
      .map(({ ts, open, high, low, close, volume }) => ({ ts, open, high, low, close, volume }));
    return { bars };
  }

  async search(q: string): Promise<SymbolInfo[]> {
    return rankMatches(await this.symbols(), (s) => s.ticker, q);
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const code of codes) {
      let s: Stats;
      try {
        s = await this.get<Stats>(`/products/${product(code)}/stats`);
      } catch (err) {
        if (err instanceof NotFoundError) continue; // unknown product: skip, keep the rest
        throw err;
      }
      const last = num(s.last);
      if (!Number.isFinite(last)) continue;
      const prev = await this.cachedPreviousDailyClose(code);
      out.push({
        id: `crypto:${code.toUpperCase()}`,
        price: last,
        changePct: prev !== null && prev > 0 ? (last / prev - 1) * 100 : null,
        ts: this.now(),
      });
    }
    return out;
  }

  /**
   * Close of the latest daily candle before the current UTC day (stats.open is a rolling 24h open, not the
   * daily-bar convention). Candles come newest-first; today's may be absent just after 00:00 UTC.
   */
  private async cachedPreviousDailyClose(code: string): Promise<number | null> {
    const day = Math.floor(this.now() / DAY);
    const key = code.toUpperCase();
    const hit = this.prevDaily.get(key);
    if (hit && hit.day === day) return hit.close;
    try {
      const close = await this.previousDailyClose(code);
      this.prevDaily.set(key, { day, close });
      return close;
    } catch (err) {
      // /candles failing must not drop the quote (nor the other codes); not cached, so the next poll retries.
      if (err instanceof NotFoundError || err instanceof ProviderError) return null;
      throw err;
    }
  }

  private async previousDailyClose(code: string): Promise<number | null> {
    const dayStart = Math.floor(this.now() / DAY) * DAY;
    const params = new URLSearchParams({
      granularity: String(GRANULARITY['1D']),
      start: new Date(dayStart - 7 * DAY).toISOString(),
      end: new Date(this.now()).toISOString(),
    });
    const rows = await this.get<Candle[]>(`/products/${product(code)}/candles?${params}`);
    let best: Candle | undefined;
    for (const c of rows) if (c[0] * 1000 < dayStart && (!best || c[0] > best[0])) best = c;
    return best && Number.isFinite(best[4]) ? best[4] : null;
  }

  /** Coinbase exposes no listing date. */
  async firstBarTs(_code: string): Promise<number | null> {
    return null;
  }

  private async candles(code: string, granularitySec: number, from: number, to: number): Promise<Bar[]> {
    const step = granularitySec * 1000;
    const span = MAX_CANDLES * step;
    const byTs = new Map<number, Bar>();
    // Internal paging is a safety net; MarketDataService already chunks to one request per call.
    for (let s = from; s < to; s += span) {
      const e = Math.min(to, s + span);
      const params = new URLSearchParams({
        granularity: String(granularitySec),
        start: new Date(s).toISOString(),
        end: new Date(e - 1).toISOString(),
      });
      const rows = await this.get<Candle[]>(`/products/${product(code)}/candles?${params}`);
      for (const [t, low, high, open, close, volume] of rows) {
        const ts = t * 1000;
        if (ts < from || ts >= to) continue;
        byTs.set(ts, { ts, open, high, low, close, volume });
      }
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }

  private async symbols(): Promise<SymbolInfo[]> {
    const now = this.now();
    if (this.products && now - this.products.at < PRODUCTS_TTL_MS) return this.products.symbols;
    const rows = await this.get<Product[]>('/products');
    const seen = new Set<string>();
    const symbols: SymbolInfo[] = [];
    for (const p of rows) {
      if (p.quote_currency !== 'USD' || p.status !== 'online' || p.trading_disabled || seen.has(p.base_currency)) continue;
      seen.add(p.base_currency);
      symbols.push({
        id: `crypto:${p.base_currency}`, assetClass: 'crypto', ticker: p.base_currency,
        name: `${p.base_currency}/USD`, exchange: 'Coinbase', pricePrecision: decimalsOf(p.quote_increment),
      });
    }
    this.products = { at: now, symbols };
    return symbols;
  }

  private get<T>(pathAndQuery: string): Promise<T> {
    return getJson<T>('coinbase', this.fetchImpl, `${this.baseUrl}${pathAndQuery}`, { headers: HEADERS });
  }
}

function product(code: string): string {
  return `${encodeURIComponent(code.toUpperCase())}-USD`;
}

import { resample, type Bar, type NativeTimeframe, type Quote, type SymbolInfo } from '@altv/shared';
import { decimalsOf, getJson, rankMatches } from './http.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from './types.js';

const BASE_URL = 'https://api.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'altv', Accept: 'application/json' };
const MAX_CANDLES = 300;
const PRODUCTS_TTL_MS = 3_600_000;
const HALF_HOUR = 30 * 60_000;

/** Granularity in seconds; 30m is not native (built from 5m). */
const GRANULARITY: Record<Exclude<NativeTimeframe, '30m'>, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 };

/** [time(s), low, high, open, close, volume] */
type Candle = [number, number, number, number, number, number];
interface Product { id: string; base_currency: string; quote_currency: string; status: string; trading_disabled?: boolean; quote_increment?: string }
interface Stats { open: string; last: string }

export interface CoinbaseOptions { fetchImpl?: typeof fetch; now?: () => number; baseUrl?: string }

export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase' as const;
  readonly assetClass = 'crypto' as const;
  readonly limits: ProviderLimits = { maxLookbackMs: {}, maxSpanPerRequestMs: {} };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private products: { at: number; symbols: SymbolInfo[] } | null = null;

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
      const s = await this.get<Stats>(`/products/${product(code)}/stats`);
      const last = Number(s.last);
      const open = Number(s.open);
      out.push({
        id: `crypto:${code.toUpperCase()}`,
        price: last,
        changePct: Number.isFinite(open) && open !== 0 ? ((last - open) / open) * 100 : null,
        ts: this.now(),
      });
    }
    return out;
  }

  /** Coinbase exposes no listing date. */
  async firstBarTs(_code: string): Promise<number | null> {
    return null;
  }

  private async candles(code: string, granularitySec: number, from: number, to: number): Promise<Bar[]> {
    const step = granularitySec * 1000;
    const span = MAX_CANDLES * step;
    const byTs = new Map<number, Bar>();
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

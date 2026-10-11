import { tfMs, type Bar, type NativeTimeframe, type Quote, type SymbolInfo } from '@altv/shared';
import { NotFoundError } from '../errors.js';
import { getJson, type HttpErrorInfo } from './http.js';
import { decimalsOf, num, rankMatches } from './util.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from './types.js';

const INTERVAL: Record<NativeTimeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1D': '1d' };
const PAGE = 1000;
const INFO_TTL_MS = 3_600_000;

type Kline = [number, string, string, string, string, string, ...unknown[]];
interface ExchangeSymbol {
  symbol: string; baseAsset: string; quoteAsset: string; status: string;
  filters?: { filterType: string; tickSize?: string }[];
}
interface Ticker24h { symbol: string; lastPrice: string; priceChangePercent: string; closeTime: number }

export interface BinanceOptions { baseUrl: string; fetchImpl?: typeof fetch; now?: () => number }

export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance' as const;
  readonly assetClass = 'crypto' as const;
  /** One kline page per chunk, so MarketDataService paces pages through the queue and persists each. */
  readonly limits: ProviderLimits = {
    maxLookbackMs: {},
    maxSpanPerRequestMs: Object.fromEntries(Object.keys(INTERVAL).map((tf) => [tf, PAGE * tfMs(tf as NativeTimeframe)])),
  };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private info: { at: number; symbols: SymbolInfo[] } | null = null;

  constructor(opts: BinanceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult> {
    const symbol = pair(code);
    const byTs = new Map<number, Bar>();
    let start = from;
    // Internal paging is a safety net; MarketDataService already chunks to one page per call.
    while (start < to) {
      const rows = await this.get<Kline[]>('/api/v3/klines', {
        symbol, interval: INTERVAL[tf], startTime: String(start), endTime: String(to - 1), limit: String(PAGE),
      });
      for (const r of rows) {
        const ts = Number(r[0]);
        if (ts < from || ts >= to) continue;
        byTs.set(ts, { ts, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
      }
      if (rows.length < PAGE) break;
      const last = Number(rows[rows.length - 1]![0]);
      if (!(last >= start)) break; // no forward progress
      start = last + tfMs(tf); // klines sit on the tf grid: a full last page ending at `to` needs no follow-up
    }
    return { bars: [...byTs.values()].sort((a, b) => a.ts - b.ts) };
  }

  async search(q: string): Promise<SymbolInfo[]> {
    const symbols = await this.symbols();
    return rankMatches(symbols, (s) => s.ticker, q);
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return [];
    const pairs = codes.map(pair);
    let rows: Ticker24h[];
    try {
      rows = await this.get<Ticker24h[]>('/api/v3/ticker/24hr', { symbols: JSON.stringify(pairs) });
    } catch (err) {
      // One unknown symbol fails the whole batch: retry per symbol and skip the unknown ones.
      if (!(err instanceof NotFoundError)) throw err;
      rows = [];
      for (const p of pairs) {
        try {
          rows.push(await this.get<Ticker24h>('/api/v3/ticker/24hr', { symbol: p }));
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
        }
      }
    }
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    const out: Quote[] = [];
    for (const p of pairs) {
      const r = bySymbol.get(p);
      if (!r) continue;
      const price = num(r.lastPrice);
      const ts = num(r.closeTime);
      if (!Number.isFinite(price) || !Number.isFinite(ts)) continue;
      const changePct = num(r.priceChangePercent);
      out.push({
        id: `crypto:${p.slice(0, -'USDT'.length)}`,
        price,
        changePct: Number.isFinite(changePct) ? changePct : null,
        ts,
      });
    }
    return out;
  }

  async firstBarTs(code: string): Promise<number | null> {
    const rows = await this.get<Kline[]>('/api/v3/klines', { symbol: pair(code), interval: '1d', startTime: '0', limit: '1' });
    const first = rows[0];
    return first ? Number(first[0]) : null;
  }

  private async symbols(): Promise<SymbolInfo[]> {
    const now = this.now();
    if (this.info && now - this.info.at < INFO_TTL_MS) return this.info.symbols;
    const res = await this.get<{ symbols: ExchangeSymbol[] }>('/api/v3/exchangeInfo', { permissions: 'SPOT' });
    const seen = new Set<string>();
    const symbols: SymbolInfo[] = [];
    for (const s of res.symbols) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || seen.has(s.baseAsset)) continue;
      seen.add(s.baseAsset);
      const tick = s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
      symbols.push({
        id: `crypto:${s.baseAsset}`, assetClass: 'crypto', ticker: s.baseAsset,
        name: `${s.baseAsset}/USD`, exchange: 'Binance', pricePrecision: decimalsOf(tick),
      });
    }
    this.info = { at: now, symbols };
    return symbols;
  }

  private get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params)}`;
    return getJson<T>('binance', this.fetchImpl, url, { mapError: mapBinanceError });
  }
}

function pair(code: string): string {
  return `${code.toUpperCase()}USDT`;
}

function mapBinanceError({ status, body }: HttpErrorInfo): Error | undefined {
  if (status === 400 && body && typeof body === 'object' && (body as { code?: unknown }).code === -1121) {
    return new NotFoundError(`binance: ${(body as { msg?: string }).msg ?? 'Invalid symbol.'}`);
  }
  return undefined;
}

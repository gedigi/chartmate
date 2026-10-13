import {
  nyParts, tagSessionFixedHours, tfMs,
  type Bar, type NativeTimeframe, type Quote, type QuoteExt, type SymbolInfo,
} from '@altv/shared';
import { NotFoundError } from '../../src/errors.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from '../../src/providers/types.js';

const MIN = 60_000;

export type PriceFn = (code: string, tf: NativeTimeframe, ts: number) => Pick<Bar, 'open' | 'high' | 'low' | 'close'>;

export interface Call { code: string; tf: NativeTimeframe; from: number; to: number }

/** Records calls; generates bars on the native grid; can be switched to throw. */
export class FakeProvider implements MarketDataProvider {
  readonly id = 'fixture' as const;
  calls: Call[] = [];
  searchCalls: string[] = [];
  quoteCalls: string[][] = [];
  firstCalls: string[] = [];
  fail: Error | null = null;
  /** Throw NotFound ("no data") for requests ending at or before this ts, like Yahoo pre-listing. */
  noDataBefore = -Infinity;
  searchFail: Error | null = null;
  delayMs = 0;
  firstTs: number | null = Date.UTC(2000, 0, 1);
  /** Optional deterministic prices (default: a function of the grid index). */
  price: PriceFn | null = null;
  /** Per-code first bar ts (bars before it don't exist), e.g. a later listing. */
  listedFrom: Record<string, number> = {};
  /** Per-code stock splits: a split date (factor 2) or { ts, factor }. */
  splits: Record<string, (number | { ts: number; factor: number })[]> = {};
  splitsCalls: { code: string; since: number }[] = [];
  splitsFail: Error | null = null;
  /** Optional quote price per code (undefined = no quote for that code); default: 10 for universe codes. */
  quotePrice: ((code: string) => number | undefined) | null = null;
  /** Optional quote timestamp (default: now). */
  quoteTs: ((code: string) => number) | null = null;
  /** Optional extended-hours part of the quote per code (default: none). */
  quoteExt: ((code: string) => QuoteExt | undefined) | null = null;
  /** Optional gate awaited inside search (to observe concurrency). */
  searchGate: Promise<void> | null = null;

  constructor(
    readonly assetClass: 'stock' | 'crypto',
    private readonly now: () => number,
    readonly limits: ProviderLimits = { maxLookbackMs: {}, maxSpanPerRequestMs: {} },
    private readonly universe: string[] = [],
  ) {}

  async search(q: string): Promise<SymbolInfo[]> {
    this.searchCalls.push(q);
    if (this.searchGate) await this.searchGate;
    if (this.searchFail) throw this.searchFail;
    const needle = q.trim().toUpperCase();
    return this.universe.filter((t) => t.includes(needle)).map((t) => this.info(t));
  }

  async fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult> {
    this.calls.push({ code, tf, from, to });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw this.fail;
    if (to <= this.noDataBefore) throw new NotFoundError('No data found, symbol may be delisted');
    return { bars: this.generate(tf, Math.max(from, this.noDataBefore, this.listedFrom[code] ?? -Infinity), Math.min(to, this.now()), code) };
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    this.quoteCalls.push(codes);
    if (this.fail) throw this.fail;
    const out: Quote[] = [];
    for (const c of codes) {
      if (!this.universe.includes(c)) continue;
      const price = this.quotePrice ? this.quotePrice(c) : 10;
      if (price === undefined) continue;
      const ext = this.quoteExt?.(c);
      out.push({ id: `${this.assetClass}:${c}`, price, changePct: 1, ts: this.quoteTs ? this.quoteTs(c) : this.now(), ...(ext ? { ext } : {}) });
    }
    return out;
  }

  async firstBarTs(code: string): Promise<number | null> {
    this.firstCalls.push(code);
    if (this.fail) throw this.fail;
    return this.firstTs;
  }

  async splitsSince(code: string, since: number): Promise<{ ts: number; ratio: string; factor: number }[]> {
    this.splitsCalls.push({ code, since });
    if (this.splitsFail) throw this.splitsFail;
    return (this.splits[code] ?? [])
      .map((sp) => (typeof sp === 'number' ? { ts: sp, factor: 2 } : sp))
      .filter((sp) => sp.ts > since)
      .map((sp) => ({ ts: sp.ts, ratio: `${sp.factor}:1`, factor: sp.factor }));
  }

  info(t: string): SymbolInfo {
    return { id: `${this.assetClass}:${t}`, assetClass: this.assetClass, ticker: t, name: `${t} Inc`, exchange: 'X', pricePrecision: 2 };
  }

  /** Stock 1h bars sit on :30 (NY 09:30-aligned); everything else on the UTC grid. */
  generate(tf: NativeTimeframe, from: number, to: number, code = ''): Bar[] {
    const step = tfMs(tf);
    const offset = this.assetClass === 'stock' && tf === '1h' ? 30 * MIN : 0;
    const out: Bar[] = [];
    for (let ts = Math.ceil((from - offset) / step) * step + offset; ts < to; ts += step) {
      const v = ts / step;
      const bar: Bar = this.price
        ? { ts, ...this.price(code, tf, ts), volume: 1 }
        : { ts, open: v % 1000, high: (v % 1000) + 2, low: (v % 1000) - 1, close: (v % 1000) + 1, volume: 1 };
      if (this.assetClass === 'stock') {
        if (tf === '1D') {
          const dow = new Date(ts).getUTCDay();
          if (dow === 0 || dow === 6) continue;
        } else {
          const dow = nyParts(ts).dow;
          const s = dow !== 0 && dow !== 6 ? tagSessionFixedHours(ts) : null;
          if (!s) continue;
          bar.session = s;
        }
      }
      out.push(bar);
    }
    return out;
  }
}

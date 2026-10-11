import {
  tagSessionFixedHours, nyParts, tfMs,
  type Bar, type NativeTimeframe, type Quote, type SymbolInfo,
} from '@altv/shared';
import { NotFoundError } from '../errors.js';
import { rankMatches } from './http.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits } from './types.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

interface FixtureSymbol { code: string; name: string; base: number; seed: number; firstTs: number }

const STOCKS: FixtureSymbol[] = [
  { code: 'AAPL', name: 'Apple Inc. (fixture)', base: 180, seed: 1, firstTs: Date.UTC(2015, 0, 1) },
  { code: 'MSFT', name: 'Microsoft Corporation (fixture)', base: 400, seed: 2, firstTs: Date.UTC(2015, 0, 1) },
  { code: 'SPY', name: 'SPDR S&P 500 ETF Trust (fixture)', base: 500, seed: 3, firstTs: Date.UTC(2015, 0, 1) },
];
const CRYPTO: FixtureSymbol[] = [
  { code: 'BTC', name: 'Bitcoin (fixture)', base: 60_000, seed: 4, firstTs: Date.UTC(2014, 0, 1) },
  { code: 'ETH', name: 'Ethereum (fixture)', base: 3_000, seed: 5, firstTs: Date.UTC(2015, 0, 1) },
];

/** Deterministic price path: seeded sine + drift, a pure function of ts. */
function price(sym: FixtureSymbol, ts: number): number {
  const years = (ts - Date.UTC(2015, 0, 1)) / (365 * DAY);
  return sym.base * (1 + 0.03 * years) * (1 + 0.1 * Math.sin(ts / (7 * DAY) + sym.seed) + 0.02 * Math.sin(ts / (3 * HOUR) + 2 * sym.seed));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function makeBar(sym: FixtureSymbol, ts: number, step: number): Bar {
  const open = round(price(sym, ts));
  const close = round(price(sym, ts + step));
  const wiggle = 0.001 * (1 + Math.abs(Math.sin(ts / (17 * MIN) + sym.seed)));
  const volume = Math.round((1000 + 500 * Math.sin(ts / HOUR + sym.seed)) * (step / MIN));
  return {
    ts, open, close,
    high: round(Math.max(open, close) * (1 + wiggle)),
    low: round(Math.min(open, close) * (1 - wiggle)),
    volume: Math.max(1, volume),
  };
}

export interface FixtureOptions { assetClass: 'stock' | 'crypto'; now?: () => number }

/** Deterministic synthetic market data for e2e/dev (`ALTV_PROVIDERS=fixture`). */
export class FixtureProvider implements MarketDataProvider {
  readonly id = 'fixture' as const;
  readonly assetClass: 'stock' | 'crypto';
  readonly limits: ProviderLimits = { maxLookbackMs: {}, maxSpanPerRequestMs: {} };
  private readonly now: () => number;
  private readonly universe: FixtureSymbol[];

  constructor(opts: FixtureOptions) {
    this.assetClass = opts.assetClass;
    this.now = opts.now ?? Date.now;
    this.universe = opts.assetClass === 'stock' ? STOCKS : CRYPTO;
  }

  async search(q: string): Promise<SymbolInfo[]> {
    const needle = q.trim().toUpperCase();
    const byTicker = rankMatches(this.universe, (s) => s.code, needle);
    const byName = this.universe.filter((s) => !byTicker.includes(s) && s.name.toUpperCase().includes(needle));
    return [...byTicker, ...byName].slice(0, 20).map((s) => this.info(s));
  }

  async fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult> {
    const sym = this.lookup(code);
    return { bars: this.generate(sym, tf, Math.max(from, sym.firstTs), Math.min(to, this.now())), firstTs: sym.firstTs };
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    const now = this.now();
    const out: Quote[] = [];
    for (const code of codes) {
      const sym = this.find(code);
      if (!sym) continue;
      // Latest 1m bar: crypto is always open; stocks scan back up to a week of minutes.
      let last: Bar | undefined;
      for (let end = now; !last && end > now - 7 * DAY; end -= DAY) {
        last = this.generate(sym, '1m', end - DAY, end).at(-1);
      }
      if (!last) continue;
      const prev = price(sym, last.ts + MIN - DAY);
      out.push({ id: this.info(sym).id, price: last.close, changePct: ((last.close - prev) / prev) * 100, ts: last.ts });
    }
    return out;
  }

  async firstBarTs(code: string): Promise<number | null> {
    return this.lookup(code).firstTs;
  }

  private generate(sym: FixtureSymbol, tf: NativeTimeframe, from: number, to: number): Bar[] {
    const step = tfMs(tf);
    const bars: Bar[] = [];
    for (let ts = Math.ceil(from / step) * step; ts < to; ts += step) {
      if (this.assetClass === 'crypto') {
        bars.push(makeBar(sym, ts, step));
      } else if (tf === '1D') {
        const dow = new Date(ts).getUTCDay();
        if (dow !== 0 && dow !== 6) bars.push(makeBar(sym, ts, step));
      } else {
        const dow = nyParts(ts).dow;
        const session = dow !== 0 && dow !== 6 ? tagSessionFixedHours(ts) : null;
        if (session) bars.push({ ...makeBar(sym, ts, step), session });
      }
    }
    return bars;
  }

  private find(code: string): FixtureSymbol | undefined {
    const c = code.toUpperCase();
    return this.universe.find((s) => s.code === c);
  }

  private lookup(code: string): FixtureSymbol {
    const sym = this.find(code);
    if (!sym) throw new NotFoundError(`fixture: unknown ${this.assetClass} symbol ${code}`);
    return sym;
  }

  private info(s: FixtureSymbol): SymbolInfo {
    return {
      id: `${this.assetClass}:${s.code}`, assetClass: this.assetClass, ticker: s.code, name: s.name,
      exchange: 'FIXTURE', pricePrecision: 2,
    };
  }
}

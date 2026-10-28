import {
  tagSessionFixedHours, nyParts, pctChange, tfMs,
  type Bar, type CorporateEvent, type NativeTimeframe, type Quote, type SymbolInfo,
} from '@chartmate/shared';
import { NotFoundError } from '../errors.js';
import { rankMatches } from './util.js';
import type { FetchBarsResult, MarketDataProvider, ProviderLimits, StockSplit } from './types.js';

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

/** Deterministic synthetic market data for e2e/dev (`CHARTMATE_PROVIDERS=fixture`). */
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
    return { bars: this.generate(sym, tf, Math.max(from, sym.firstTs), Math.min(to, this.now())) };
  }

  async quotes(codes: string[]): Promise<Quote[]> {
    const now = this.now();
    const out: Quote[] = [];
    for (const code of codes) {
      const sym = this.find(code);
      if (!sym) continue;
      // Latest 1m bar: crypto is always open; stocks: the latest REGULAR bar (scanning back up to a week of minutes).
      let last: Bar | undefined;
      let latest: Bar | undefined;
      for (let end = now; !last && end > now - 7 * DAY; end -= DAY) {
        const day = this.generate(sym, '1m', end - DAY, end);
        latest ??= day.at(-1);
        last = this.assetClass === 'crypto' ? day.at(-1) : day.filter((b) => b.session === 'regular').at(-1);
      }
      if (!last) continue;
      const prev = this.prevDailyClose(sym, last.ts);
      const q: Quote = { id: this.info(sym).id, price: last.close, changePct: pctChange(last.close, prev), ts: last.ts };
      // While the simulated clock is in pre/post hours, the latest extended bar rides along vs the regular close.
      const session = latest?.session;
      if (latest && (session === 'pre' || session === 'post') && latest.ts > last.ts && this.extendedNow(now) === session) {
        const changePct = pctChange(latest.close, last.close);
        if (changePct !== null) q.ext = { session, price: latest.close, changePct, ts: latest.ts };
      }
      out.push(q);
    }
    return out;
  }

  /** The stock extended session the simulated clock is in (weekday 04:00–09:30 / 16:00–20:00 NY), else null. */
  private extendedNow(now: number): 'pre' | 'post' | null {
    const dow = nyParts(now).dow;
    if (this.assetClass !== 'stock' || dow === 0 || dow === 6) return null;
    const s = tagSessionFixedHours(now);
    return s === 'pre' || s === 'post' ? s : null;
  }

  /** Close of the daily bar before the day containing `ts` (crypto: previous UTC day; stocks: previous weekday). */
  private prevDailyClose(sym: FixtureSymbol, ts: number): number {
    let prevTs = Math.floor(ts / DAY) * DAY - DAY;
    if (this.assetClass === 'stock') while ([0, 6].includes(new Date(prevTs).getUTCDay())) prevTs -= DAY;
    return makeBar(sym, prevTs, DAY).close;
  }

  async firstBarTs(code: string): Promise<number | null> {
    return this.lookup(code).firstTs;
  }

  /** Fixture data has no splits. */
  async splitsSince(_code: string, _since: number): Promise<StockSplit[]> {
    return [];
  }

  /**
   * Deterministic events for stocks (none for crypto): a quarterly dividend (ex-date the 10th of Feb, May, Aug, Nov,
   * 09:30 New York) since the first bar, earnings on the 25th of Jan, Apr, Jul and Oct for the last four quarters, and
   * the next report two days from today, so it is always on the chart, whatever the date. Reports are at 21:30 UTC,
   * after the close in summer and winter time alike. One MSFT split. SPY, a fund, reports no earnings.
   */
  async events(code: string): Promise<CorporateEvent[]> {
    const sym = this.lookup(code);
    if (this.assetClass !== 'stock') return [];
    const now = this.now();
    const out: CorporateEvent[] = [];
    const amount = round(sym.base * 0.0015);
    for (let y = new Date(sym.firstTs).getUTCFullYear(), m = 1; ; m += 3) {
      if (m > 11) { y += 1; m -= 12; }
      const ts = Date.UTC(y, m, 10, 13, 30);
      if (ts > now) break;
      if (ts >= sym.firstTs) out.push({ kind: 'dividend', ts, amount });
    }
    if (code !== 'SPY') {
      const reports: number[] = [];
      for (let y = new Date(now).getUTCFullYear() - 2, m = 0; reports.length < 5 || reports[reports.length - 1]! <= now; m += 3) {
        if (m > 11) { y += 1; m -= 12; }
        reports.push(Date.UTC(y, m, 25, 21, 30));
      }
      const past = reports.filter((ts) => ts <= now).slice(-4);
      past.forEach((ts, i) => {
        const epsEstimate = round(sym.base / 100 + 0.1 * i);
        out.push({ kind: 'earnings', ts, epsActual: round(epsEstimate * (i % 2 === 0 ? 1.05 : 0.97)), epsEstimate });
      });
      const today = new Date(now);
      const next = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2, 21, 30);
      out.push({ kind: 'earnings', ts: next, epsEstimate: round(sym.base / 100 + 0.4), upcoming: true });
    }
    if (code === 'MSFT') out.push({ kind: 'split', ts: Date.UTC(2018, 1, 14, 14, 30), ratio: '2:1' });
    return out.sort((a, b) => a.ts - b.ts);
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

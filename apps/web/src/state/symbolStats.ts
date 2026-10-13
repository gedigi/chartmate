import { nyParts, tagSessionFixedHours, type AssetClass, type Bar, type Quote } from '@chartmate/shared';

const DAY = 86_400_000;

/** Figures of the symbol detail panel, from daily bars (and the live quote when there is one). */
export interface SymbolStats {
  price: number;
  /** The latest daily bar (the current session's while it trades). */
  open: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  prevClose: number | null;
  /** Mean volume of the 30 daily bars before the latest one; null with fewer than 5. */
  avgVolume30: number | null;
  /** Highest high / lowest low of the daily bars of the last 365 days (the live price included). */
  high52: number;
  low52: number;
}

/**
 * Detail figures from ascending daily bars (null without bars). A live quote newer than the latest bar's day moves
 * the price and stretches the day range to include it.
 */
export function symbolStats(bars: readonly Bar[], quote: Quote | undefined, now: number): SymbolStats | null {
  const last = bars.at(-1);
  if (!last) return null;
  const price = quote?.price ?? last.close;
  const dayHigh = Math.max(last.high, price);
  const dayLow = Math.min(last.low, price);
  const prior = bars.slice(Math.max(0, bars.length - 31), -1);
  const year = bars.filter((b) => b.ts >= now - 365 * DAY);
  return {
    price, open: last.open, dayHigh, dayLow, volume: last.volume,
    prevClose: bars.at(-2)?.close ?? null,
    avgVolume30: prior.length >= 5 ? prior.reduce((s, b) => s + b.volume, 0) / prior.length : null,
    high52: Math.max(price, ...year.map((b) => b.high)),
    low52: Math.min(price, ...year.map((b) => b.low)),
  };
}

export type MarketStatus = 'open' | 'pre' | 'post' | 'closed' | 'always';

/** Quotes older than this are not "live": the regular session reads as closed (holidays, halts, stale data). */
const LIVE_MS = 20 * 60_000;

/**
 * Market status line of the detail panel. Crypto always trades. Stocks: an extended-hours quote says pre / post;
 * otherwise open while the NY clock is in regular hours on a weekday AND the regular quote is fresh (so a holiday
 * reads as closed); closed otherwise. Baskets: none (null).
 */
export function marketStatus(assetClass: AssetClass, quote: Quote | undefined, now: number): MarketStatus | null {
  if (assetClass === 'crypto') return 'always';
  if (assetClass !== 'stock') return null;
  if (quote?.ext) return quote.ext.session;
  const dow = nyParts(now).dow;
  const regular = dow !== 0 && dow !== 6 && tagSessionFixedHours(now) === 'regular';
  return regular && quote !== undefined && now - quote.ts <= LIVE_MS ? 'open' : 'closed';
}

export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  open: 'Market open', pre: 'Pre-market', post: 'After hours', closed: 'Market closed', always: 'Trades around the clock',
};

/** Position of `value` in [lo, hi] as 0–1 (clamped; 0.5 for an empty range). */
export function rangePosition(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0.5;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

/** "1.23B", "45.6M", "7.8K", "950". */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

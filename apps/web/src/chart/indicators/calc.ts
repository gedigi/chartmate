import { nyParts } from '@chartmate/shared';

/** Pure indicator calculations (no klinecharts import) — unit-tested in test/indicators/calc.test.ts. */

export interface VwapBar { timestamp: number; high: number; low: number; close: number; volume?: number }
export interface AtrBar { high: number; low: number; close: number }

/**
 * Session VWAP: cumulative Σ(typical·volume) / Σ(volume) with typical = (h+l+c)/3, restarting whenever
 * `dayKey(timestamp)` changes. Null while the session's cumulative volume is 0 (or volume is missing).
 */
export function vwap(bars: VwapBar[], dayKey: (ts: number) => number): Array<{ vwap: number | null }> {
  const out: Array<{ vwap: number | null }> = [];
  let key: number | null = null;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const k = dayKey(b.timestamp);
    if (k !== key) {
      key = k;
      pv = 0;
      vol = 0;
    }
    const v = b.volume ?? 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
    out.push({ vwap: vol > 0 ? pv / vol : null });
  }
  return out;
}

/**
 * Average True Range with Wilder smoothing.
 * TR = max(h−l, |h−prevC|, |l−prevC|) (first bar: h−l). The first ATR (at index period−1) is the mean of
 * the first `period` TRs; then ATR = (prevATR·(period−1) + TR) / period.
 */
export function atr(bars: AtrBar[], period: number): Array<{ atr: number | null }> {
  const out: Array<{ atr: number | null }> = [];
  const p = Math.max(1, Math.floor(period));
  let prevClose: number | null = null;
  let sum = 0;
  let prev: number | null = null;
  bars.forEach((b, i) => {
    const tr = prevClose === null
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    prevClose = b.close;
    if (i < p - 1) {
      sum += tr;
      out.push({ atr: null });
    } else if (i === p - 1) {
      prev = (sum + tr) / p;
      out.push({ atr: prev });
    } else {
      prev = ((prev as number) * (p - 1) + tr) / p;
      out.push({ atr: prev });
    }
  });
  return out;
}

/** New York calendar date of `ts` as yyyymmdd (DST-aware) — session key for stocks and baskets. */
export function nyDayKey(ts: number): number {
  const p = nyParts(ts);
  return p.y * 10000 + p.m * 100 + p.d;
}

/** UTC calendar day number of `ts` — session key for crypto. */
export function utcDayKey(ts: number): number {
  return Math.floor(ts / 86_400_000);
}

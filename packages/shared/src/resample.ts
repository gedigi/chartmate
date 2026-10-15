import type { Bar, Timeframe } from './types.js';
import { isIntraday, tfMs } from './timeframes.js';
import { memoByNyDay, nyParts, nyToUtc } from './nytime.js';

export type Calendar = 'utc' | 'nyse-rth' | 'nyse-eth';

const DAY = 86_400_000;

export function bucketStart(ts: number, tf: Timeframe, calendar: Calendar): number {
  if (tf === '1D') return Math.floor(ts / DAY) * DAY;
  if (tf === '1W') {
    const day = Math.floor(ts / DAY) * DAY;
    const dow = new Date(day).getUTCDay(); // 0=Sun
    return day - ((dow + 6) % 7) * DAY;
  }
  if (tf === '1M') {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const ms = tfMs(tf);
  if (calendar === 'utc') return Math.floor(ts / ms) * ms;
  const p = nyParts(ts);
  return anchored(ts, ms, sessionAnchor(p, calendar));
}

/** The NYSE calendar's bucket anchor on NY date `p`: 09:30 (RTH) or 04:00 (ETH) NY. */
function sessionAnchor(p: { y: number; m: number; d: number }, calendar: 'nyse-rth' | 'nyse-eth'): number {
  return calendar === 'nyse-rth' ? nyToUtc(p.y, p.m, p.d, 9, 30) : nyToUtc(p.y, p.m, p.d, 4, 0);
}

function anchored(ts: number, ms: number, anchor: number): number {
  return anchor + Math.floor((ts - anchor) / ms) * ms;
}

/** `bucketStart` for one (tf, calendar), memoized per NY day for the NYSE calendars (one Intl lookup per day). */
function bucketStarter(tf: Timeframe, calendar: Calendar): (ts: number) => number {
  if (calendar === 'utc' || !isIntraday(tf)) return (ts) => bucketStart(ts, tf, calendar);
  const ms = tfMs(tf);
  const anchorOf = memoByNyDay((day) =>
    // A 24-hour day has one UTC offset throughout, so the anchor is a fixed time after its midnight.
    day.end - day.start === DAY ? day.start + (calendar === 'nyse-rth' ? 9.5 : 4) * 3_600_000 : sessionAnchor(day, calendar));
  return (ts) => anchored(ts, ms, anchorOf(ts));
}

/**
 * Returns `bars` ordered by ts with equal-ts duplicates removed (the last occurrence in input
 * order wins). Already-sorted, duplicate-free input is returned as-is (no copy).
 */
export function normalizeBars(bars: Bar[]): Bar[] {
  let clean = true;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.ts <= bars[i - 1]!.ts) { clean = false; break; }
  }
  if (clean) return bars;
  const sorted = bars.slice().sort((a, b) => a.ts - b.ts); // Array#sort is stable
  const out: Bar[] = [];
  for (const b of sorted) {
    if (out.length > 0 && out[out.length - 1]!.ts === b.ts) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

/**
 * Aggregates bars into `tf` buckets. Input need not be sorted: it is sorted defensively (stable,
 * by ts) and bars with equal ts are deduped (last occurrence wins). Gaps yield no empty buckets.
 */
export function resample(input: Bar[], tf: Timeframe, calendar: Calendar): Bar[] {
  const bars = normalizeBars(input);
  const startOf = bucketStarter(tf, calendar);
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let uniform = true;
  /** A bucket is simulated only when every input bar is. */
  let allSimulated = true;
  const flush = () => {
    if (!cur) return;
    // Mixed sessions: no single tag fits. Filter sessions before resampling (see filterSession), never after.
    if (!uniform) cur.session = undefined;
    if (allSimulated) cur.simulated = true;
  };
  for (const b of bars) {
    const ts = startOf(b.ts);
    if (cur && cur.ts === ts) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      if (b.session !== cur.session) uniform = false;
      if (!b.simulated) allSimulated = false;
    } else {
      flush();
      cur = { ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, session: b.session };
      uniform = true;
      allSimulated = b.simulated === true;
      out.push(cur);
    }
  }
  flush();
  return out;
}

import { isIntraday, nyParts, nyToUtc, tfMs, type Timeframe } from '@chartmate/shared';

/**
 * Date range presets of the range bar under the chart: each picks a fitting interval and shows that period, ending
 * at the latest bar. Pure math (no klinecharts): ChartAdapter.showRange applies it.
 */
export type RangePreset = '1D' | '5D' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'All';
export const RANGE_PRESETS: readonly RangePreset[] = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', 'All'];

/** Spoken name of each preset (tooltip and accessible name). */
export const RANGE_TITLES: Record<RangePreset, string> = {
  '1D': '1 day', '5D': '5 days', '1M': '1 month', '3M': '3 months', '6M': '6 months',
  YTD: 'Year to date', '1Y': '1 year', All: 'All history',
};

/**
 * Whose calendar the range follows: 'stock' (stocks and stock-only baskets: trading sessions, New York dates) or
 * 'crypto' (crypto and baskets holding crypto: around the clock, UTC dates).
 */
export type RangeCalendar = 'stock' | 'crypto';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const TIMEFRAMES: Record<Exclude<RangePreset, 'All'>, Timeframe> = {
  '1D': '5m', '5D': '15m', '1M': '1h', '3M': '1D', '6M': '1D', YTD: '1D', '1Y': '1D',
};

/** The bar interval of a preset; All takes the one allTimeframe picked (weekly unless given). */
export function rangeTimeframe(preset: RangePreset, allTf: '1W' | '1M' = '1W'): Timeframe {
  return preset === 'All' ? allTf : TIMEFRAMES[preset];
}

/** All shows weekly bars only while each gets at least this many pixels; narrower, it switches to monthly bars. */
export const MIN_ALL_BAR_PX = 2;

/**
 * Interval of All for a history from `firstTs` to `latestTs` on a chart `plotWidth` px wide: weekly bars while the
 * whole history fits at MIN_ALL_BAR_PX per bar or more, else monthly ones (about 10 years of weekly bars fit a
 * 1000 px chart). Unknown history or width → weekly.
 */
export function allTimeframe(firstTs: number | null, latestTs: number, plotWidth: number): '1W' | '1M' {
  if (firstTs === null || !(plotWidth > 0)) return '1W';
  const weeks = Math.round((latestTs - firstTs) / WEEK) + 1;
  return weeks * MIN_ALL_BAR_PX <= plotWidth ? '1W' : '1M';
}

/**
 * Deepest history a range ever needs, measured back from the latest bar: older pages are never requested past it
 * (intraday stock history is limited, see the test against the data source's limits). Daily and longer: unbounded.
 */
export function rangeLookbackMs(preset: RangePreset): number {
  switch (preset) {
    case '1D': return 10 * DAY; // one session (or 24 h), long weekends included
    case '5D': return 20 * DAY; // five sessions around holidays
    case '1M': return 32 * DAY;
    default: return Infinity;
  }
}

interface YMD { y: number; m: number; d: number }

/** The calendar date of bar time `ts`: New York for intraday stock bars, else UTC (daily bars are UTC midnights). */
function dateOf(ts: number, ny: boolean): YMD {
  if (ny) {
    const p = nyParts(ts);
    return { y: p.y, m: p.m, d: p.d };
  }
  const d = new Date(ts);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Start of date `x` (out-of-range days roll over, like Date.UTC): New York midnight or UTC midnight. */
function startOf(x: YMD, ny: boolean): number {
  const n = new Date(Date.UTC(x.y, x.m - 1, x.d));
  return ny ? nyToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0) : n.getTime();
}

/** `x` minus `months` calendar months, the day clamped to the target month's last day. */
function minusMonths(x: YMD, months: number): YMD {
  const first = new Date(Date.UTC(x.y, x.m - 1 - months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(x.d, last) };
}

const MONTHS: Partial<Record<RangePreset, number>> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
const SESSIONS: Partial<Record<RangePreset, number>> = { '1D': 1, '5D': 5 };

/**
 * First bar time of preset `preset` over bars at `times` (ascending) of interval `tf`: bars at or after it are the
 * range. The range ends at the latest bar:
 * - 1D / 5D: stocks the last 1 / 5 sessions (dates with bars, so weekends and holidays are skipped; extended hours
 *   included when loaded); crypto the last 24 h / 5 × 24 h, the forming bar included.
 * - 1M / 3M / 6M / 1Y: from the day after the same date that many months earlier.
 * - YTD: from January 1 of the latest bar's year (so on the January 1 holiday it shows the year that just ended).
 * Dates are New York dates for intraday stock bars, UTC dates otherwise.
 * -Infinity: everything (All, no bars, or fewer sessions loaded than needed: load older bars, or show them all).
 */
export function rangeStart(preset: RangePreset, times: readonly number[], tf: Timeframe, calendar: RangeCalendar): number {
  const latest = times.at(-1);
  if (latest === undefined || preset === 'All') return -Infinity;
  const ny = calendar === 'stock' && isIntraday(tf);
  const sessions = SESSIONS[preset];
  if (sessions !== undefined) {
    if (calendar === 'crypto') return latest + tfMs(tf) - sessions * 24 * HOUR;
    let count = 0;
    let dayStart = Infinity;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i]! >= dayStart) continue;
      dayStart = startOf(dateOf(times[i]!, ny), ny);
      if (++count === sessions) return dayStart;
    }
    return -Infinity;
  }
  const last = dateOf(latest, ny);
  if (preset === 'YTD') return startOf({ y: last.y, m: 1, d: 1 }, ny);
  const back = minusMonths(last, MONTHS[preset]!);
  return startOf({ ...back, d: back.d + 1 }, ny);
}

/** Number of bars (times ascending) at or after `start`. */
export function visibleBarCount(times: readonly number[], start: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < start) lo = mid + 1;
    else hi = mid;
  }
  return times.length - lo;
}

/** The chart's bar width limits (px). */
export const MIN_BAR_SPACE = 1;
export const MAX_BAR_SPACE = 50;

/**
 * Bar width (px) that spreads `count` bars over a plot `width` px wide, keeping the `rightMargin` px gap after the
 * latest bar. Clamped to the chart's limits: too many bars show the newest that fit, very few are drawn wide.
 */
export function fitBarSpace(count: number, width: number, rightMargin: number): number {
  if (count <= 0) return MAX_BAR_SPACE;
  return Math.min(MAX_BAR_SPACE, Math.max(MIN_BAR_SPACE, (width - rightMargin) / count));
}

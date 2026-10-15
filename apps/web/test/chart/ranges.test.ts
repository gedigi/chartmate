import { nyToUtc, tfMs, type Timeframe } from '@chartmate/shared';
import { describe, expect, it } from 'vitest';
import { initialWindowMs } from '../../src/chart/periods';
import {
  allTimeframe, fitBarSpace, MAX_BAR_SPACE, MIN_ALL_BAR_PX, MIN_BAR_SPACE, MIN_SESSION_BARS, RANGE_PRESETS, rangeLabel, rangeLookbackMs, rangeStart,
  rangeTimeframe, visibleBarCount,
} from '../../src/chart/ranges';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Stock intraday bars of the NY weekdays given ('YYYY-MM-DD'), from `open` to `close` (NY wall clock, hh:mm). */
function stockBars(dates: string[], tf: Timeframe, open = [9, 30], close = [16, 0]): number[] {
  const out: number[] = [];
  for (const s of dates) {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const start = nyToUtc(y, m, d, open[0]!, open[1]!);
    const end = nyToUtc(y, m, d, close[0]!, close[1]!);
    for (let t = start; t < end; t += tfMs(tf)) out.push(t);
  }
  return out;
}

/** Daily bars (UTC midnight) of every weekday in [from, to]. */
function dailyWeekdays(from: string, to: string): number[] {
  const out: number[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
  }
  return out;
}

/** Bars every `step` ms in [from, to). */
function continuous(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
}

describe('RANGE_PRESETS', () => {
  it('lists the presets in order, in sentence case ("All", acronyms uppercase)', () => {
    expect(RANGE_PRESETS).toEqual(['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', 'All']);
  });
});

describe('rangeTimeframe', () => {
  it.each([
    ['1D', '5m'], ['5D', '15m'], ['1M', '1h'], ['3M', '1D'], ['6M', '1D'], ['YTD', '1D'], ['1Y', '1D'], ['All', '1W'],
  ] as const)('%s → %s', (preset, tf) => expect(rangeTimeframe(preset)).toBe(tf));

  it('All takes the interval it is given (weekly or monthly, see allTimeframe)', () => {
    expect(rangeTimeframe('All', '1M')).toBe('1M');
    expect(rangeTimeframe('1Y', '1M')).toBe('1D');
  });
});

describe('allTimeframe', () => {
  const latest = Date.UTC(2026, 9, 12);
  it('weekly while every weekly bar gets at least MIN_ALL_BAR_PX', () => {
    const first = latest - 520 * 7 * DAY; // 521 weekly bars
    expect(allTimeframe(first, latest, 521 * MIN_ALL_BAR_PX)).toBe('1W');
    expect(allTimeframe(first, latest, 521 * MIN_ALL_BAR_PX - 1)).toBe('1M');
  });
  it('a long history on a narrow chart is monthly, a short one stays weekly', () => {
    expect(allTimeframe(Date.UTC(1980, 11, 12), latest, 1000)).toBe('1M');
    expect(allTimeframe(Date.UTC(2024, 0, 1), latest, 400)).toBe('1W');
  });
  it('unknown history (no bars, failed probe) or no width yet → weekly', () => {
    expect(allTimeframe(null, latest, 800)).toBe('1W');
    expect(allTimeframe(Date.UTC(1980, 0, 1), latest, 0)).toBe('1W');
  });
});

describe('rangeStart: stocks', () => {
  it('1D: the latest session from its NY midnight (RTH bars)', () => {
    const times = stockBars(['2026-10-13', '2026-10-14', '2026-10-15'], '5m');
    const start = rangeStart('1D', times, '5m', 'stock');
    expect(start).toBe(nyToUtc(2026, 10, 15, 0, 0));
    expect(visibleBarCount(times, start)).toBe(78);
  });

  it('1D with extended hours includes the pre-market of the latest session', () => {
    const times = stockBars(['2026-10-14', '2026-10-15'], '5m', [4, 0], [20, 0]);
    const start = rangeStart('1D', times, '5m', 'stock');
    expect(visibleBarCount(times, start)).toBe(192);
    expect(times.find((t) => t >= start)).toBe(nyToUtc(2026, 10, 15, 4, 0));
  });

  it('1D early in a session (fewer than MIN_SESSION_BARS bars): the previous session too', () => {
    const prev = stockBars(['2026-10-14'], '5m', [4, 0], [20, 0]);
    const early = stockBars(['2026-10-15'], '5m', [4, 0], [4, 45]); // 9 pre-market bars
    expect(early).toHaveLength(9);
    expect(rangeStart('1D', [...prev, ...early], '5m', 'stock')).toBe(nyToUtc(2026, 10, 14, 0, 0));
    const enough = stockBars(['2026-10-15'], '5m', [4, 0], [5, 0]);
    expect(enough).toHaveLength(MIN_SESSION_BARS);
    expect(rangeStart('1D', [...prev, ...enough], '5m', 'stock')).toBe(nyToUtc(2026, 10, 15, 0, 0));
    // Only the young session loaded: older bars are needed first.
    expect(rangeStart('1D', early, '5m', 'stock')).toBe(-Infinity);
  });

  it('1D on a weekend: the latest bar is Friday\'s, so Friday\'s session', () => {
    const times = stockBars(['2026-10-15', '2026-10-16'], '5m'); // Thu, Fri
    expect(rangeStart('1D', times, '5m', 'stock')).toBe(nyToUtc(2026, 10, 16, 0, 0));
  });

  it('5D: the last five sessions, skipping weekends and holidays (sessions come from the bars)', () => {
    // Fri Nov 20 … Fri Nov 27 2026: Thanksgiving (Thu Nov 26) has no bars.
    const dates = ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'];
    const times = stockBars(dates, '15m');
    const start = rangeStart('5D', times, '15m', 'stock');
    expect(start).toBe(nyToUtc(2026, 11, 20, 0, 0));
    expect(visibleBarCount(times, start)).toBe(5 * 26);
  });

  it('5D with fewer sessions loaded → -Infinity (load older bars, or show everything)', () => {
    const times = stockBars(['2026-10-14', '2026-10-15'], '15m');
    expect(rangeStart('5D', times, '15m', 'stock')).toBe(-Infinity);
  });

  it('1M on hourly bars starts the day after the same date a month earlier, at NY midnight (across DST)', () => {
    // Latest session Tue Nov 3 2026 (EST); a month earlier is Oct 3 (EDT): the window starts Oct 4 00:00 EDT.
    const times = stockBars(['2026-10-01', '2026-10-02', '2026-10-05', '2026-11-02', '2026-11-03'], '1h');
    const start = rangeStart('1M', times, '1h', 'stock');
    expect(start).toBe(nyToUtc(2026, 10, 4, 0, 0));
    expect(start).toBe(Date.UTC(2026, 9, 4, 4, 0));
  });

  it('3M / 6M / 1Y on daily bars (UTC midnight dates); the day clamps to the end of a shorter month', () => {
    const times = dailyWeekdays('2024-01-01', '2026-05-29'); // latest Fri May 29 2026
    expect(rangeStart('3M', times, '1D', 'stock')).toBe(Date.UTC(2026, 2, 1)); // Feb 29 doesn't exist → Feb 28 + 1 day
    expect(rangeStart('6M', times, '1D', 'stock')).toBe(Date.UTC(2025, 10, 30)); // Nov 29 + 1 day
    expect(rangeStart('1Y', times, '1D', 'stock')).toBe(Date.UTC(2025, 4, 30));
    const end31 = dailyWeekdays('2025-01-01', '2026-03-31'); // latest Tue Mar 31 2026
    expect(rangeStart('1M', end31, '1D', 'stock')).toBe(Date.UTC(2026, 2, 1)); // Feb 28 + 1 day
  });

  it('1Y spans about a year of sessions', () => {
    const times = dailyWeekdays('2023-01-01', '2026-10-15');
    const n = visibleBarCount(times, rangeStart('1Y', times, '1D', 'stock'));
    expect(n).toBeGreaterThanOrEqual(260);
    expect(n).toBeLessThanOrEqual(262);
  });

  it('YTD starts on January 1 of the latest bar\'s year', () => {
    const times = dailyWeekdays('2025-06-01', '2026-10-15');
    expect(rangeStart('YTD', times, '1D', 'stock')).toBe(Date.UTC(2026, 0, 1));
  });

  it('YTD on the year\'s first session (January 1 is a holiday): that session only', () => {
    const times = dailyWeekdays('2025-06-01', '2026-12-31').concat(Date.UTC(2027, 0, 4));
    const start = rangeStart('YTD', times, '1D', 'stock');
    expect(start).toBe(Date.UTC(2027, 0, 1));
    expect(visibleBarCount(times, start)).toBe(1);
  });

  it('YTD before the year\'s first session (on the January 1 holiday): the latest bar\'s year, so the year just ended', () => {
    const times = dailyWeekdays('2025-06-01', '2026-12-31');
    expect(rangeStart('YTD', times, '1D', 'stock')).toBe(Date.UTC(2026, 0, 1));
  });

  it('YTD on intraday stock bars uses the New York date', () => {
    // 2027-01-01 00:30 UTC is still Dec 31 in New York.
    const times = [Date.UTC(2026, 11, 31, 20, 0), Date.UTC(2027, 0, 1, 0, 30)];
    expect(rangeStart('YTD', times, '1h', 'stock')).toBe(nyToUtc(2026, 1, 1, 0, 0));
  });
});

describe('rangeStart: crypto (UTC, around the clock)', () => {
  const latest = Date.UTC(2026, 9, 18, 13, 55); // Sunday
  it('1D: the last 24 hours, the forming bar included (a weekend is no different)', () => {
    const times = continuous(latest - 3 * DAY, latest + 1, 5 * MIN);
    const start = rangeStart('1D', times, '5m', 'crypto');
    expect(start).toBe(latest + 5 * MIN - DAY);
    expect(visibleBarCount(times, start)).toBe(288);
  });

  it('5D: five times 24 hours', () => {
    const times = continuous(latest - 10 * DAY, latest + 1, 15 * MIN);
    expect(visibleBarCount(times, rangeStart('5D', times, '15m', 'crypto'))).toBe(480);
  });

  it('1M on hourly bars: from the UTC date a month earlier', () => {
    const times = continuous(latest - 60 * DAY, latest + 1, HOUR);
    expect(rangeStart('1M', times, '1h', 'crypto')).toBe(Date.UTC(2026, 8, 19));
  });

  it('YTD uses the UTC date: 2027-01-01 00:00 UTC is already 2027', () => {
    const times = continuous(Date.UTC(2026, 11, 30), Date.UTC(2027, 0, 1, 1), HOUR);
    expect(rangeStart('YTD', times, '1h', 'crypto')).toBe(Date.UTC(2027, 0, 1));
  });
});

describe('rangeStart: edge cases', () => {
  it('All → -Infinity (the whole history)', () => {
    expect(rangeStart('All', [1, 2, 3], '1W', 'stock')).toBe(-Infinity);
  });
  it('no bars → -Infinity', () => {
    for (const p of RANGE_PRESETS) expect(rangeStart(p, [], rangeTimeframe(p), 'stock')).toBe(-Infinity);
  });
  it('a short history: the range starts before the first bar, so every bar is shown', () => {
    const times = dailyWeekdays('2026-08-03', '2026-10-15'); // listed in August
    const start = rangeStart('1Y', times, '1D', 'stock');
    expect(start).toBeLessThan(times[0]!);
    expect(visibleBarCount(times, start)).toBe(times.length);
  });
});

describe('visibleBarCount', () => {
  it('counts bars at or after the start', () => {
    expect(visibleBarCount([10, 20, 30, 40], 20)).toBe(3);
    expect(visibleBarCount([10, 20, 30, 40], 25)).toBe(2);
    expect(visibleBarCount([10, 20, 30, 40], -Infinity)).toBe(4);
    expect(visibleBarCount([10, 20, 30, 40], 50)).toBe(0);
    expect(visibleBarCount([], 0)).toBe(0);
  });
});

describe('fitBarSpace', () => {
  it('spreads the bars over the width left of the right margin', () => {
    expect(fitBarSpace(100, 880, 80)).toBe(8);
  });
  it('clamps to the chart\'s bar width limits (too many bars: the newest that fit are shown)', () => {
    expect(fitBarSpace(10_000, 880, 80)).toBe(MIN_BAR_SPACE);
    expect(fitBarSpace(1, 880, 80)).toBe(MAX_BAR_SPACE);
    expect(fitBarSpace(0, 880, 80)).toBe(MAX_BAR_SPACE);
  });
});

describe('rangeLookbackMs: intraday ranges stay inside the stock data source\'s intraday history', () => {
  // Free intraday history: 5m / 15m ~59 days, 1h ~729 days (the stock provider's limits; see README "Data sources").
  const providerLookback: Partial<Record<Timeframe, number>> = { '5m': 59 * DAY, '15m': 59 * DAY, '1h': 729 * DAY };
  it.each(['1D', '5D', '1M'] as const)('%s: deepest bar needed plus one more page is within the limit', (preset) => {
    const tf = rangeTimeframe(preset);
    expect(rangeLookbackMs(preset) + initialWindowMs(tf)).toBeLessThan(providerLookback[tf]!);
  });
  it('daily and longer ranges are unbounded', () => {
    expect(rangeLookbackMs('1Y')).toBe(Infinity);
    expect(rangeLookbackMs('All')).toBe(Infinity);
  });
});

describe('rangeLabel: the dates a shown range spans, in the chart timezone', () => {
  it('daily bars: dates, the year once when both ends share it', () => {
    expect(rangeLabel(Date.UTC(2025, 9, 16), Date.UTC(2026, 9, 15), '1D', 'UTC')).toBe('Oct 16, 2025 – Oct 15, 2026');
    expect(rangeLabel(Date.UTC(2026, 0, 2), Date.UTC(2026, 9, 15), '1D', 'UTC')).toBe('Jan 2 – Oct 15, 2026');
    expect(rangeLabel(Date.UTC(2026, 9, 15), Date.UTC(2026, 9, 15), '1D', 'UTC')).toBe('Oct 15, 2026');
  });
  it('weekly bars read like daily ones; monthly bars by month', () => {
    expect(rangeLabel(Date.UTC(2015, 0, 5), Date.UTC(2026, 9, 12), '1W', 'UTC')).toBe('Jan 5, 2015 – Oct 12, 2026');
    expect(rangeLabel(Date.UTC(2015, 0, 1), Date.UTC(2026, 9, 1), '1M', 'UTC')).toBe('Jan 2015 – Oct 2026');
  });
  it('intraday bars: date and time of the first and latest bar, the date once within a day', () => {
    const tz = 'America/New_York';
    expect(rangeLabel(nyToUtc(2026, 10, 14, 9, 30), nyToUtc(2026, 10, 14, 15, 55), '5m', tz)).toBe('Oct 14, 09:30 – 15:55');
    expect(rangeLabel(nyToUtc(2026, 10, 8, 9, 30), nyToUtc(2026, 10, 14, 15, 45), '15m', tz)).toBe('Oct 8, 09:30 – Oct 14, 15:45');
    expect(rangeLabel(Date.UTC(2026, 9, 17, 12, 5), Date.UTC(2026, 9, 18, 12, 0), '5m', 'UTC')).toBe('Oct 17, 12:05 – Oct 18, 12:00');
  });
});

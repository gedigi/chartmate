import { describe, expect, it } from 'vitest';
import { nyToUtc } from '@chartmate/shared';
import {
  AXIS_CHAR_PX, AXIS_EDGE_PX, barCloseTime, calendarTicks, countdownText, crosshairDate, hasCountdown, MIN_TICK_GAP_PX, tickLabelFits, zonedParts,
} from '../../src/chart/timeLabels';

const NY = 'America/New_York';
const utc = (s: string) => Date.parse(`${s}Z`);

describe('zonedParts', () => {
  it('reads the calendar in the chart timezone', () => {
    expect(zonedParts(utc('2026-09-30T16:30:00'), NY)).toEqual({ year: 2026, month: 8, day: 30, weekday: 3, hour: 12, minute: 30 });
    expect(zonedParts(utc('2026-01-01T00:00:00'), 'UTC')).toMatchObject({ year: 2026, month: 0, day: 1, hour: 0 });
  });
});

describe('calendarTicks', () => {
  const DAY = 86_400_000;
  /** Weekday dates (UTC midnight) from `from` to `to`, inclusive. */
  const weekdays = (from: string, to: string) => {
    const out: number[] = [];
    for (let t = utc(`${from}T00:00:00`); t <= utc(`${to}T00:00:00`); t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const labels = (ticks: Array<{ label: string }>) => ticks.map((t) => t.label);
  const gaps = (ticks: Array<{ index: number }>) => ticks.slice(1).map((t, i) => t.index - ticks[i]!.index);
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Month index of a month tick label (a year label is January). */
  const monthOf = (label: string) => (/^\d{4}$/.test(label) ? 0 : MONTH_LABELS.indexOf(label));

  it('one year of daily bars on a wide chart: a tick on the first session of each month, the year in January', () => {
    const times = weekdays('2025-10-15', '2026-10-15'); // the first bar is only context (the one before the view)
    const ticks = calendarTicks(times, 3.5, '1D', 'UTC');
    expect(labels(ticks)).toEqual(['Nov', 'Dec', '2026', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(times[ticks[0]!.index]).toBe(utc('2025-11-03T00:00:00')); // Nov 1–2 2025 is a weekend
    expect(times[ticks[2]!.index]).toBe(utc('2026-01-01T00:00:00'));
  });

  it('regression: months of 20 and 23 sessions at ~2.9 px a bar never skip a month', () => {
    // Synthetic sessions: months alternate 20 and 23 bars (58 px and 66.7 px at 2.9 px a bar).
    const times: number[] = [];
    for (let m = 0; m < 14; m++) for (let d = 1; d <= (m % 2 === 0 ? 20 : 23); d++) times.push(Date.UTC(2025, 9 + m, d));
    for (const space of [2.9, 3, 3.3]) {
      const ticks = calendarTicks(times, space, '1D', 'UTC');
      const months = labels(ticks).map(monthOf);
      const step = months.length > 1 ? (months[1]! - months[0]! + 12) % 12 : 0;
      expect(step === 1 || step === 3).toBe(true); // months, or quarters: one unit throughout
      for (let i = 1; i < months.length; i++) expect((months[i]! - months[i - 1]! + 12) % 12).toBe(step);
      for (const g of gaps(ticks)) expect(g * space).toBeGreaterThanOrEqual(MIN_TICK_GAP_PX);
    }
    expect(labels(calendarTicks(times, 2.9, '1D', 'UTC'))).toEqual(['2026', 'Apr', 'Jul', 'Oct']); // 20 × 2.9 < 60: quarters
    expect(labels(calendarTicks(times, 3, '1D', 'UTC'))).toHaveLength(13); // every month
  });

  it('the same year on a narrow chart: quarters', () => {
    const times = weekdays('2025-10-15', '2026-10-15');
    const ticks = calendarTicks(times, 1.9, '1D', 'UTC');
    expect(labels(ticks)).toEqual(['2026', 'Apr', 'Jul', 'Oct']);
  });

  it('weeks: one tick per week on its first session, evenly; a new month names itself on the week grid', () => {
    const times = weekdays('2026-09-14', '2026-10-30');
    const ticks = calendarTicks(times, 15, '1D', 'UTC'); // weeks 75 px apart
    expect(labels(ticks)).toEqual(['21', '28', 'Oct 5', '12', '19', '26']);
    expect(new Set(gaps(ticks))).toEqual(new Set([5]));
  });

  it('daily bars at ~10 px: half months (the 1st and the 15th, or the next session) between weeks and months', () => {
    const times = weekdays('2026-09-01', '2026-11-30');
    const ticks = calendarTicks(times, 10, '1D', 'UTC'); // weeks 50 px (too close), half months ≥ 100 px
    expect(labels(ticks)).toEqual(['15', 'Oct', '15', 'Nov', '16']); // Nov 1 and Nov 15 2026 are Sundays
  });

  it('intraday: the session start shows the day, then the finest clock step that fits (New York time)', () => {
    const day = (d: number) => Array.from({ length: 78 }, (_, i) => nyToUtc(2026, 10, d, 9, 30) + i * 5 * 60_000);
    const times = [day(13).at(-1)!, ...day(14)]; // the previous session's last bar, then Oct 14
    const ticks = calendarTicks(times, 11, '5m', 'America/New_York');
    expect(labels(ticks)).toEqual(['14', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
  });

  it('extended hours: hour steps sit on clock multiples of the step, not on the 04:00 session open', () => {
    const day = (d: number) => Array.from({ length: 192 }, (_, i) => nyToUtc(2026, 10, d, 4, 0) + i * 5 * 60_000);
    const times = [day(13).at(-1)!, ...day(14), ...day(15)];
    const ticks = calendarTicks(times, 2, '5m', 'America/New_York'); // 3 h = 72 px; 2 h = 48 px
    // 06:00 is only 2 h after the open and 18:00 2 h before the next one: those step ticks give way to the day labels.
    expect(labels(ticks)).toEqual(['14', '09:00', '12:00', '15:00', '15', '09:00', '12:00', '15:00', '18:00']);
  });

  it('intraday across a month: the month start reads "Oct 1"', () => {
    const times = [utc('2026-09-30T19:00:00'), utc('2026-09-30T20:00:00'), utc('2026-10-01T13:00:00'), utc('2026-10-01T14:00:00')];
    expect(labels(calendarTicks(times, 80, '1h', 'America/New_York'))).toEqual(['16:00', 'Oct 1', '10:00']);
  });

  it('crypto hours (UTC, around the clock): midnight is on every step\'s grid', () => {
    const times = Array.from({ length: 73 }, (_, i) => utc('2026-10-12T00:00:00') + i * 3_600_000);
    const ticks = calendarTicks(times, 12, '1h', 'UTC'); // 6 h = 72 px
    expect(labels(ticks)).toEqual(['06:00', '12:00', '18:00', '13', '06:00', '12:00', '18:00', '14', '06:00', '12:00', '18:00', '15']);
    expect(new Set(gaps(ticks))).toEqual(new Set([6]));
  });

  it('monthly bars over years: one tick per year (or per 2 / 5 / 10 years when narrower)', () => {
    const months = Array.from({ length: 142 }, (_, i) => Date.UTC(2015, i, 1));
    expect(labels(calendarTicks(months, 6.5, '1M', 'UTC'))).toEqual(['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']);
    expect(labels(calendarTicks(months, 3, '1M', 'UTC'))).toEqual(['2016', '2018', '2020', '2022', '2024', '2026']);
  });

  it('no ticks without a previous bar to compare with', () => {
    expect(calendarTicks([utc('2026-01-01T00:00:00')], 10, '1D', 'UTC')).toEqual([]);
    expect(calendarTicks([], 10, '1D', 'UTC')).toEqual([]);
  });
});

describe('tickLabelFits', () => {
  it('keeps a label at least AXIS_EDGE_PX inside both plot edges, by its estimated width', () => {
    const half = (s: string) => (s.length * AXIS_CHAR_PX) / 2;
    expect(tickLabelFits(AXIS_EDGE_PX + half('2026'), '2026', 500)).toBe(true);
    expect(tickLabelFits(AXIS_EDGE_PX + half('2026') - 1, '2026', 500)).toBe(false);
    expect(tickLabelFits(500 - AXIS_EDGE_PX - half('Sep 21'), 'Sep 21', 500)).toBe(true);
    expect(tickLabelFits(500 - AXIS_EDGE_PX - half('Sep 21') + 1, 'Sep 21', 500)).toBe(false);
    // A short label may sit closer to the edge than a long one.
    expect(tickLabelFits(25, '9', 500)).toBe(true);
    expect(tickLabelFits(25, 'Sep 21', 500)).toBe(false);
  });
});

describe('crosshairDate', () => {
  it('weekday, date and 2-digit year; the time intraday; month and year monthly', () => {
    expect(crosshairDate(utc('2026-09-30T16:30:00'), '1h', NY)).toBe("Wed Sep 30 '26 · 12:30");
    expect(crosshairDate(utc('2026-09-30T00:00:00'), '1D', 'UTC')).toBe("Wed Sep 30 '26");
    expect(crosshairDate(utc('2026-09-01T00:00:00'), '1M', 'UTC')).toBe('Sep 2026');
  });
});

describe('bar-close countdown', () => {
  it('intraday bars and daily crypto bars only', () => {
    expect(hasCountdown('5m', 'stock')).toBe(true);
    expect(hasCountdown('4h', 'basket')).toBe(true);
    expect(hasCountdown('1D', 'crypto')).toBe(true);
    expect(hasCountdown('1D', 'stock')).toBe(false);
    expect(hasCountdown('1W', 'crypto')).toBe(false);
  });

  it('m:ss under an hour, h:mm:ss above, "Closed" once the bar ended', () => {
    const bar = utc('2026-10-13T14:00:00');
    expect(countdownText(bar, '5m', bar + 1_000)).toBe('4:59');
    expect(countdownText(bar, '1h', bar + 59 * 60_000 + 59_500)).toBe('0:01');
    expect(countdownText(bar, '4h', bar + 1_000)).toBe('3:59:59');
    expect(countdownText(bar, '1D', bar)).toBe('24:00:00');
    expect(countdownText(bar, '5m', bar + 5 * 60_000)).toBe('Closed');
  });

  it('stock-like charts: the bar ends at the session close (16:00 NY regular, 20:00 extended; DST-aware)', () => {
    // EDT (UTC-4): 15:30 NY = 19:30Z; the 1h bar closes at 16:00 NY = 20:00Z, not 16:30.
    const b1530 = utc('2026-10-13T19:30:00');
    expect(barCloseTime(b1530, '1h', 'rth')).toBe(utc('2026-10-13T20:00:00'));
    expect(countdownText(b1530, '1h', utc('2026-10-13T19:45:00'), 'rth')).toBe('15:00');
    expect(countdownText(b1530, '1h', utc('2026-10-13T20:00:00'), 'rth')).toBe('Closed');
    // 4h bar from 13:30 NY: closes at 16:00 NY (2.5 h), not 17:30.
    const b1330 = utc('2026-10-13T17:30:00');
    expect(barCloseTime(b1330, '4h', 'rth')).toBe(utc('2026-10-13T20:00:00'));
    expect(countdownText(b1330, '4h', b1330, 'rth')).toBe('2:30:00');
    // Extended hours: 20:00 NY; a 4h bar from 16:00 NY ends exactly then.
    expect(barCloseTime(utc('2026-10-13T20:00:00'), '4h', 'eth')).toBe(utc('2026-10-14T00:00:00'));
    expect(barCloseTime(utc('2026-10-13T22:00:00'), '4h', 'eth')).toBe(utc('2026-10-14T00:00:00'));
    // EST (UTC-5) in January: 16:00 NY = 21:00Z.
    expect(barCloseTime(utc('2026-01-13T20:30:00'), '1h', 'rth')).toBe(utc('2026-01-13T21:00:00'));
    // Crypto (no session): the clock alone.
    expect(barCloseTime(b1530, '1h')).toBe(b1530 + 3_600_000);
  });
});

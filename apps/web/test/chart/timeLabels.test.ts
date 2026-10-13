import { describe, expect, it } from 'vitest';
import { axisTickLabels, countdownText, crosshairDate, hasCountdown, zonedParts } from '../../src/chart/timeLabels';

const NY = 'America/New_York';
const utc = (s: string) => Date.parse(`${s}Z`);

describe('zonedParts', () => {
  it('reads the calendar in the chart timezone', () => {
    expect(zonedParts(utc('2026-09-30T16:30:00'), NY)).toEqual({ year: 2026, month: 8, day: 30, weekday: 3, hour: 12, minute: 30 });
    expect(zonedParts(utc('2026-01-01T00:00:00'), 'UTC')).toMatchObject({ year: 2026, month: 0, day: 1, hour: 0 });
  });
});

describe('axisTickLabels', () => {
  it('intraday: month on the first tick and at a month change, day number on a new day, else the time', () => {
    const ts = ['2026-09-29T14:00:00', '2026-09-29T18:00:00', '2026-09-30T14:00:00', '2026-10-01T14:00:00', '2026-10-01T17:30:00'].map(utc);
    expect(axisTickLabels(ts, '1h', NY)).toEqual(['Sep 29', '14:00', '30', 'Oct 1', '13:30']);
  });

  it('daily / weekly: year, month or day; monthly: year or month', () => {
    const days = ['2025-12-29', '2025-12-31', '2026-01-02', '2026-01-06', '2026-02-02'].map((d) => utc(`${d}T00:00:00`));
    expect(axisTickLabels(days, '1D', 'UTC')).toEqual(['2025', '31', '2026', '6', 'Feb']);
    expect(axisTickLabels(days, '1W', 'UTC')).toEqual(['2025', '31', '2026', '6', 'Feb']);
    const months = ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'].map((d) => utc(`${d}T00:00:00`));
    expect(axisTickLabels(months, '1M', 'UTC')).toEqual(['2025', 'Dec', '2026', 'Feb']);
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
});

import { describe, expect, it } from 'vitest';
import { isSameSplit, tradingDayGap } from '../../src/market/splitMatch.js';

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);

describe('split matching', () => {
  it('counts the NY weekdays between two dates, skipping weekends', () => {
    expect(tradingDayGap(d(2026, 11, 3), d(2026, 11, 3))).toBe(0);
    expect(tradingDayGap(d(2026, 11, 2), d(2026, 11, 3))).toBe(1); // Mon, Tue
    expect(tradingDayGap(d(2026, 11, 3), d(2026, 11, 2))).toBe(1); // order does not matter
    expect(tradingDayGap(d(2026, 11, 2), d(2026, 11, 4))).toBe(2); // Mon, Wed
    expect(tradingDayGap(d(2026, 11, 6), d(2026, 11, 9))).toBe(1); // Fri, Mon
    expect(tradingDayGap(d(2026, 11, 8), d(2026, 11, 9))).toBe(1); // Sun (evening before), Mon
    expect(tradingDayGap(d(2026, 11, 6), d(2026, 11, 8))).toBe(0); // Fri, Sun
    expect(tradingDayGap(d(2026, 11, 5), d(2026, 11, 9))).toBe(2); // Thu, Mon
  });

  it('the same split: the same ratio within one NY trading day', () => {
    const tue = { day: d(2026, 11, 3), factor: 2 };
    expect(isSameSplit(tue, { day: d(2026, 11, 2), factor: 2 })).toBe(true);
    expect(isSameSplit(tue, { day: d(2026, 11, 4), factor: 2 })).toBe(true);
    expect(isSameSplit(tue, { day: d(2026, 11, 5), factor: 2 })).toBe(false);
    expect(isSameSplit(tue, { day: d(2026, 11, 3), factor: 4 })).toBe(false);
    expect(isSameSplit({ day: d(2026, 11, 6), factor: 0.1 }, { day: d(2026, 11, 9), factor: 0.1 })).toBe(true);
    // Floating-point noise from parsing 'a:b' is not a different ratio.
    expect(isSameSplit({ day: d(2026, 11, 3), factor: 1 / 3 }, { day: d(2026, 11, 3), factor: 1 / 3 + 1e-15 })).toBe(true);
  });

  it('an unknown ratio (either side) matches any ratio on a nearby day', () => {
    // Splits recorded before ratios were (migration 007), or reported without one.
    expect(isSameSplit({ day: d(2026, 11, 3), factor: null }, { day: d(2026, 11, 4), factor: 2 })).toBe(true);
    expect(isSameSplit({ day: d(2026, 11, 3), factor: 3 }, { day: d(2026, 11, 3), factor: null })).toBe(true);
    expect(isSameSplit({ day: d(2026, 11, 3), factor: null }, { day: d(2026, 11, 5), factor: null })).toBe(false);
  });
});

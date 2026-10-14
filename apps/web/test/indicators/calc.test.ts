import { describe, expect, it } from 'vitest';
import { atr, nyDayKey, utcDayKey, vwap } from '../../src/chart/indicators/calc';

describe('vwap', () => {
  // dayKey: bars 0–2 on day 1, bars 3–5 on day 2.
  const day = (ts: number) => (ts < 3 ? 1 : 2);
  const bars = [
    // day 1
    { timestamp: 0, high: 12, low: 8, close: 10, volume: 100 }, // tp 10 → 1000/100 = 10
    { timestamp: 1, high: 13, low: 10, close: 13, volume: 300 }, // tp 12 → (1000+3600)/400 = 11.5
    { timestamp: 2, high: 15, low: 12, close: 12, volume: 100 }, // tp 13 → (4600+1300)/500 = 11.8
    // day 2 (reset)
    { timestamp: 3, high: 21, low: 19, close: 20, volume: 0 }, // cumulative volume 0 → null
    { timestamp: 4, high: 22, low: 20, close: 21, volume: 200 }, // tp 21 → 4200/200 = 21
    { timestamp: 5, high: 26, low: 22, close: 24, volume: 100 }, // tp 24 → (4200+2400)/300 = 22
  ];

  it('computes cumulative typical-price VWAP and resets at the day boundary', () => {
    const out = vwap(bars, day).map((r) => r.vwap);
    expect(out[0]).toBeCloseTo(10, 10);
    expect(out[1]).toBeCloseTo(11.5, 10);
    expect(out[2]).toBeCloseTo(11.8, 10);
    expect(out[3]).toBeNull();
    expect(out[4]).toBeCloseTo(21, 10);
    expect(out[5]).toBeCloseTo(22, 10);
  });

  it('treats missing volume as zero (null until volume arrives)', () => {
    const out = vwap([{ timestamp: 0, high: 2, low: 1, close: 1.5 }, { timestamp: 1, high: 3, low: 3, close: 3, volume: 10 }], () => 1);
    expect(out).toEqual([{ vwap: null }, { vwap: 3 }]);
  });

  it('returns [] for no bars', () => {
    expect(vwap([], () => 0)).toEqual([]);
  });
});

describe('atr', () => {
  const bars = [
    { high: 10, low: 8, close: 9 }, // TR = h−l = 2
    { high: 11, low: 9, close: 10.5 }, // max(2, |11−9|=2, |9−9|=0) = 2
    { high: 13, low: 10, close: 12 }, // max(3, |13−10.5|=2.5, |10−10.5|=0.5) = 3 → ATR = (2+2+3)/3 = 7/3
    { high: 12, low: 11, close: 11.5 }, // max(1, |12−12|=0, |11−12|=1) = 1 → ATR = (7/3·2 + 1)/3 = 17/9
    { high: 15, low: 12, close: 14 }, // max(3, |15−11.5|=3.5, |12−11.5|=0.5) = 3.5 → ATR = (17/9·2 + 3.5)/3 = 131/54
  ];

  it('uses Wilder smoothing seeded by the mean of the first `period` true ranges', () => {
    const out = atr(bars, 3).map((r) => r.atr);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(7 / 3, 10);
    expect(out[3]).toBeCloseTo(17 / 9, 10);
    expect(out[4]).toBeCloseTo(131 / 54, 10);
  });

  it('is all null when there are fewer bars than the period', () => {
    expect(atr(bars.slice(0, 2), 3)).toEqual([{ atr: null }, { atr: null }]);
  });

  it('period 1 is the true range itself', () => {
    expect(atr(bars, 1).map((r) => r.atr)).toEqual([2, 2, 3, 1, 3.5]);
  });
});

describe('day keys', () => {
  it('nyDayKey uses the New York calendar date (DST-aware)', () => {
    // 2024-03-11 03:30 UTC = 2024-03-10 23:30 EDT; 04:30 UTC = 00:30 EDT on the 11th.
    expect(nyDayKey(Date.UTC(2024, 2, 11, 3, 30))).toBe(20240310);
    expect(nyDayKey(Date.UTC(2024, 2, 11, 4, 30))).toBe(20240311);
    // Winter: 04:30 UTC = 23:30 EST on the previous day.
    expect(nyDayKey(Date.UTC(2024, 0, 11, 4, 30))).toBe(20240110);
  });

  it('utcDayKey uses the UTC calendar date', () => {
    expect(utcDayKey(Date.UTC(2024, 0, 11, 23, 59))).toBe(utcDayKey(Date.UTC(2024, 0, 11, 0, 0)));
    expect(utcDayKey(Date.UTC(2024, 0, 12, 0, 0))).not.toBe(utcDayKey(Date.UTC(2024, 0, 11, 23, 59)));
  });
});

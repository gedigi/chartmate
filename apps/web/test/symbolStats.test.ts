import type { Bar, Quote } from '@chartmate/shared';
import { describe, expect, it } from 'vitest';
import { compactNumber, marketStatus, rangePosition, symbolStats } from '../src/state/symbolStats';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-13T15:00:00Z'); // Tue 11:00 New York
const bar = (daysAgo: number, o: number, h: number, l: number, c: number, v = 100): Bar =>
  ({ ts: Math.floor(NOW / DAY) * DAY - daysAgo * DAY, open: o, high: h, low: l, close: c, volume: v });

describe('symbolStats', () => {
  it('null without bars', () => {
    expect(symbolStats([], undefined, NOW)).toBeNull();
  });

  it('day figures from the latest bar, previous close, 30-bar average volume, 52-week range', () => {
    const bars = [bar(400, 1, 500, 0.5, 1), ...Array.from({ length: 40 }, (_, i) => bar(40 - i, 10, 12, 9, 11, 100 + i)), bar(0, 11, 13, 10, 12, 50)];
    const s = symbolStats(bars, undefined, NOW)!;
    expect(s).toMatchObject({ price: 12, open: 11, dayHigh: 13, dayLow: 10, volume: 50, prevClose: 11, high52: 13, low52: 9 });
    // The 30 bars before the latest: volumes 110..139.
    expect(s.avgVolume30).toBeCloseTo(124.5);
  });

  it('a live quote moves the price and stretches the day range', () => {
    const q: Quote = { id: 'stock:X', price: 14, changePct: 1, ts: NOW };
    expect(symbolStats([bar(1, 10, 11, 9, 10), bar(0, 10, 13, 10, 12)], q, NOW)).toMatchObject({ price: 14, dayHigh: 14, dayLow: 10, high52: 14 });
  });

  it('too little history: no average volume; one bar: no previous close', () => {
    expect(symbolStats([bar(0, 1, 2, 1, 2)], undefined, NOW)).toMatchObject({ prevClose: null, avgVolume30: null });
  });
});

describe('marketStatus', () => {
  const q = (ts: number, ext?: Quote['ext']): Quote => ({ id: 'stock:X', price: 1, changePct: 0, ts, ...(ext ? { ext } : {}) });
  it('crypto always trades; baskets have no status', () => {
    expect(marketStatus('crypto', undefined, NOW)).toBe('always');
    expect(marketStatus('basket', undefined, NOW)).toBeNull();
  });

  it('stocks: open in regular hours with a fresh quote, else closed; extended quotes say pre / post', () => {
    expect(marketStatus('stock', q(NOW - 60_000), NOW)).toBe('open');
    expect(marketStatus('stock', q(NOW - 3 * 3_600_000), NOW)).toBe('closed'); // stale (e.g. a holiday)
    expect(marketStatus('stock', undefined, NOW)).toBe('closed');
    const sat = Date.parse('2026-10-17T15:00:00Z');
    expect(marketStatus('stock', q(sat), sat)).toBe('closed');
    expect(marketStatus('stock', q(NOW, { session: 'pre', price: 1, changePct: 0, ts: NOW }), NOW)).toBe('pre');
  });
});

describe('helpers', () => {
  it('rangePosition clamps and handles an empty range', () => {
    expect(rangePosition(5, 0, 10)).toBe(0.5);
    expect(rangePosition(-1, 0, 10)).toBe(0);
    expect(rangePosition(11, 0, 10)).toBe(1);
    expect(rangePosition(3, 3, 3)).toBe(0.5);
  });

  it('compactNumber', () => {
    expect(compactNumber(1_234_000_000)).toBe('1.23B');
    expect(compactNumber(45_600_000)).toBe('45.60M');
    expect(compactNumber(7_800)).toBe('7.8K');
    expect(compactNumber(950)).toBe('950');
  });
});

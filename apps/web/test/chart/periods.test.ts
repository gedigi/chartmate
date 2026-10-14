import { TIMEFRAMES, tfMs, type Timeframe } from '@chartmate/shared';
import { describe, expect, it } from 'vitest';
import { forwardRetryWindowMs, fromPeriod, initialWindowMs, pollIntervalMs, toPeriod } from '../../src/chart/periods';

const DAY = 86_400_000;

describe('toPeriod', () => {
  const cases: Array<[Timeframe, { type: string; span: number }]> = [
    ['1m', { type: 'minute', span: 1 }],
    ['5m', { type: 'minute', span: 5 }],
    ['15m', { type: 'minute', span: 15 }],
    ['30m', { type: 'minute', span: 30 }],
    ['1h', { type: 'hour', span: 1 }],
    ['2h', { type: 'hour', span: 2 }],
    ['4h', { type: 'hour', span: 4 }],
    ['1D', { type: 'day', span: 1 }],
    ['1W', { type: 'week', span: 1 }],
    ['1M', { type: 'month', span: 1 }],
  ];
  it.each(cases)('%s → %o', (tf, p) => expect(toPeriod(tf)).toEqual(p));

  it('round-trips through fromPeriod for every timeframe', () => {
    for (const tf of TIMEFRAMES) expect(fromPeriod(toPeriod(tf))).toBe(tf);
  });

  it('fromPeriod rejects unknown periods', () => {
    expect(() => fromPeriod({ type: 'second', span: 1 })).toThrow();
    expect(() => fromPeriod({ type: 'minute', span: 3 })).toThrow();
  });
});

describe('initialWindowMs', () => {
  const cases: Array<[Timeframe, number]> = [
    ['1m', 2 * DAY], ['5m', 7 * DAY], ['15m', 14 * DAY], ['30m', 28 * DAY],
    ['1h', 60 * DAY], ['2h', 120 * DAY], ['4h', 240 * DAY],
    ['1D', 3 * 365 * DAY], ['1W', 15 * 365 * DAY], ['1M', 40 * 365 * DAY],
  ];
  it.each(cases)('%s → %d ms', (tf, ms) => expect(initialWindowMs(tf)).toBe(ms));

  it('every initial window fits the server 4000-bar span cap', () => {
    for (const tf of TIMEFRAMES) expect(initialWindowMs(tf)).toBeLessThanOrEqual(4000 * tfMs(tf));
  });
});

describe('forwardRetryWindowMs', () => {
  it('is 4× the initial window, capped at 3900 bars', () => {
    expect(forwardRetryWindowMs('1m')).toBe(3900 * 60_000); // 4×2d = 11520 bars → capped
    expect(forwardRetryWindowMs('1D')).toBe(3900 * DAY); // 4×3y = 4380 bars → capped
    expect(forwardRetryWindowMs('1M')).toBe(4 * 40 * 365 * DAY); // 160y ≈ 1947 bars → not capped
  });
  it('never exceeds the 4000-bar cap', () => {
    for (const tf of TIMEFRAMES) {
      expect(forwardRetryWindowMs(tf)).toBe(Math.min(4 * initialWindowMs(tf), 3900 * tfMs(tf)));
      expect(forwardRetryWindowMs(tf)).toBeLessThan(4000 * tfMs(tf));
    }
  });
});

describe('pollIntervalMs', () => {
  it('crypto 5 s, stock 15 s, basket 15 s (caller passes crypto for crypto-containing baskets)', () => {
    expect(pollIntervalMs('crypto')).toBe(5000);
    expect(pollIntervalMs('stock')).toBe(15000);
    expect(pollIntervalMs('basket')).toBe(15000);
  });
});

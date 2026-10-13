import { describe, expect, it } from 'vitest';
import {
  centreLabel, defaultGeometry, distancePct, distanceTicks, endAfterBars, evaluateOutcome, formatAmount, fromPositionPoints,
  outcomeLabel, positionMetrics, pressedMove, priceFromPct, priceFromTicks, qtyDecimals, riskAmount, sideOf, stopLabel, targetLabel,
  toPositionPoints, validatePrices, type PositionGeometry,
} from '../../src/chart/position';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const g: PositionGeometry = { start: T0, end: T0 + 20 * DAY, entry: 100, target: 102, stop: 98 };
const short: PositionGeometry = { start: T0, end: T0 + 20 * DAY, entry: 100, target: 98, stop: 102 };
const settings = { accountSize: 10000, riskMode: 'percent' as const, riskValue: 1, currency: 'USD' };

describe('position points schema', () => {
  it('four points: entry, target, stop (all at the start time) and end (at the entry price)', () => {
    expect(toPositionPoints(g)).toEqual([
      { timestamp: T0, value: 100 }, { timestamp: T0, value: 102 }, { timestamp: T0, value: 98 }, { timestamp: T0 + 20 * DAY, value: 100 },
    ]);
    expect(fromPositionPoints(toPositionPoints(g))).toEqual(g);
    expect(fromPositionPoints([{ timestamp: 1, value: 1 }])).toBeNull();
    expect(fromPositionPoints([{ timestamp: 1, value: 1 }, { value: 2 }, { timestamp: 1, value: 0.5 }, { timestamp: 2, value: 1 }])).toBeNull();
  });

  it('sideOf', () => {
    expect(sideOf('longPosition')).toBe('long');
    expect(sideOf('shortPosition')).toBe('short');
    expect(sideOf('segment')).toBeNull();
  });
});

describe('defaults and validation', () => {
  it('default target / stop at ±2 % rounded to the precision (short inverted)', () => {
    expect(defaultGeometry('long', T0, 123.456, T0 + 5, 2)).toEqual({ start: T0, end: T0 + 5, entry: 123.46, target: 125.93, stop: 120.99 });
    expect(defaultGeometry('short', T0, 100, T0 + 5, 2)).toEqual({ start: T0, end: T0 + 5, entry: 100, target: 98, stop: 102 });
  });

  it('long needs stop < entry < target, short target < entry < stop', () => {
    expect(validatePrices('long', g)).toBeNull();
    expect(validatePrices('short', short)).toBeNull();
    expect(validatePrices('long', { ...g, target: 99 })).toMatch(/target.*above.*entry/i);
    expect(validatePrices('long', { ...g, stop: 101 })).toMatch(/stop.*below.*entry/i);
    expect(validatePrices('short', { ...short, target: 101 })).toMatch(/target.*below.*entry/i);
    expect(validatePrices('short', { ...short, stop: 99 })).toMatch(/stop.*above.*entry/i);
    expect(validatePrices('long', { ...g, entry: 0 })).toMatch(/positive/i);
    expect(validatePrices('long', { ...g, stop: Number.NaN })).toMatch(/positive/i);
  });

  it('% and tick distances convert both ways (tick = 10^-precision)', () => {
    expect(distancePct('long', 100, 102)).toBeCloseTo(2);
    expect(distancePct('short', 100, 98)).toBeCloseTo(2);
    expect(priceFromPct('long', 'target', 100, 3, 2)).toBe(103);
    expect(priceFromPct('long', 'stop', 100, 1.5, 2)).toBe(98.5);
    expect(priceFromPct('short', 'target', 100, 3, 2)).toBe(97);
    expect(priceFromPct('short', 'stop', 100, 1.5, 2)).toBe(101.5);
    expect(distanceTicks(100, 102.5, 2)).toBe(250);
    expect(distanceTicks(100, 99.99, 2)).toBe(1);
    expect(priceFromTicks('long', 'target', 100, 250, 2)).toBe(102.5);
    expect(priceFromTicks('long', 'stop', 100, 250, 2)).toBe(97.5);
    expect(priceFromTicks('short', 'target', 100, 1, 0)).toBe(99);
    expect(priceFromTicks('short', 'stop', 100, 3, 1)).toBe(100.3);
  });
});

describe('risk, quantity and R:R', () => {
  it('risk amount: % of the account or a fixed amount', () => {
    expect(riskAmount(settings)).toBe(100);
    expect(riskAmount({ ...settings, riskMode: 'amount', riskValue: 250 })).toBe(250);
  });

  it('quantity decimals: stocks and baskets whole units, crypto 6 decimals', () => {
    expect(qtyDecimals('stock')).toBe(0);
    expect(qtyDecimals('basket')).toBe(0);
    expect(qtyDecimals('crypto')).toBe(6);
  });

  it('qty = risk / |entry − stop| (floored), reward / risk amounts, R:R and % distances', () => {
    expect(positionMetrics('long', g, settings, 0)).toEqual({ qty: 50, riskAmount: 100, rewardAmount: 100, rr: 1, targetPct: 2, stopPct: 2 });
    const m = positionMetrics('long', { ...g, target: 106, stop: 97 }, settings, 0);
    expect(m.qty).toBe(33); // 100 / 3 = 33.33 → 33 shares
    expect(m.riskAmount).toBeCloseTo(99);
    expect(m.rewardAmount).toBeCloseTo(198);
    expect(m.rr).toBeCloseTo(2);
    const c = positionMetrics('short', { ...short, entry: 60000, target: 57000, stop: 61500 }, settings, 6);
    expect(c.qty).toBeCloseTo(0.066666, 6);
    expect(c.rr).toBe(2);
    expect(c.targetPct).toBeCloseTo(5);
    expect(c.stopPct).toBeCloseTo(2.5);
  });
});

describe('labels', () => {
  const m = positionMetrics('long', g, settings, 0);
  it('target / stop / centre labels', () => {
    expect(targetLabel(g, m, 2, 'USD')).toBe('Target: 102.00 (+2.00%) +100.00 USD');
    expect(stopLabel(g, m, 2, 'USD')).toBe('Stop: 98.00 (-2.00%) -100.00 USD');
    expect(centreLabel('long', m)).toBe('Long · Qty 50 · R:R 1.00');
    expect(centreLabel('short', { ...m, qty: 0.0667, rr: 2.345 })).toBe('Short · Qty 0.0667 · R:R 2.35');
  });

  it('amounts keep two decimals with thousands separators', () => {
    expect(formatAmount(1234.5, 'EUR')).toBe('+1,234.50 EUR');
    expect(formatAmount(-0.004, 'USD')).toBe('-0.00 USD');
  });
});

describe('outcome (bars of the displayed timeframe after the entry, up to the end)', () => {
  const bar = (i: number, high: number, low: number, close = (high + low) / 2) => ({ timestamp: T0 + i * DAY, high, low, close });

  it('target hit (long): first bar whose high reaches the target', () => {
    const bars = [bar(0, 103, 90), bar(1, 101, 99), bar(2, 102.5, 99.5), bar(3, 90, 80)];
    expect(evaluateOutcome(bars, 'long', g, 50)).toEqual({ kind: 'target', ts: T0 + 2 * DAY, price: 102, pnl: 100, pnlPct: 2 });
  });

  it('stop hit (long), and the entry bar itself is not evaluated', () => {
    const bars = [bar(0, 120, 50), bar(1, 101, 97.5)];
    expect(evaluateOutcome(bars, 'long', g, 50)).toEqual({ kind: 'stop', ts: T0 + DAY, price: 98, pnl: -100, pnlPct: -2 });
  });

  it('both levels inside the same bar → stop first (conservative)', () => {
    expect(evaluateOutcome([bar(1, 103, 97)], 'long', g, 50)).toMatchObject({ kind: 'stop' });
    expect(evaluateOutcome([bar(1, 103, 97)], 'short', short, 50)).toMatchObject({ kind: 'stop', pnl: -100 });
  });

  it('short side: target when the low reaches it, stop when the high does', () => {
    expect(evaluateOutcome([bar(1, 100.5, 97.9)], 'short', short, 50)).toEqual({ kind: 'target', ts: T0 + DAY, price: 98, pnl: 100, pnlPct: 2 });
    expect(evaluateOutcome([bar(1, 102, 99)], 'short', short, 50)).toMatchObject({ kind: 'stop', price: 102, pnl: -100, pnlPct: -2 });
  });

  it('no hit while the last bar is inside the range: open with the P&L at the last close', () => {
    const o = evaluateOutcome([bar(1, 101, 99, 100.5), bar(2, 101.5, 99.5, 101)], 'long', g, 50);
    expect(o).toEqual({ kind: 'open', ts: T0 + 2 * DAY, price: 101, pnl: 50, pnlPct: 1 });
    expect(evaluateOutcome([bar(1, 101, 99, 99)], 'short', short, 50)).toMatchObject({ kind: 'open', pnl: 50, pnlPct: 1 });
  });

  it('no hit up to the end time and later bars exist: ended with the P&L at the last close in range', () => {
    const o = evaluateOutcome([bar(1, 101, 99, 100.2), bar(20, 101, 99, 99), bar(21, 200, 1)], 'long', g, 50);
    expect(o).toMatchObject({ kind: 'ended', ts: T0 + 20 * DAY, price: 99, pnl: -50 });
  });

  it('pending without any bar after the entry', () => {
    expect(evaluateOutcome([bar(0, 200, 1)], 'long', g, 50)).toEqual({ kind: 'pending' });
    expect(evaluateOutcome([], 'long', g, 50)).toEqual({ kind: 'pending' });
  });

  it('outcome labels', () => {
    const date = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    expect(outcomeLabel({ kind: 'target', ts: T0 + DAY, price: 102, pnl: 100, pnlPct: 2 }, 'USD', date)).toBe('Target hit · +100.00 USD (+2.00%) · 2024-01-02');
    expect(outcomeLabel({ kind: 'stop', ts: T0 + DAY, price: 98, pnl: -100, pnlPct: -2 }, 'USD', date)).toBe('Stop hit · -100.00 USD (-2.00%) · 2024-01-02');
    expect(outcomeLabel({ kind: 'open', ts: T0 + DAY, price: 101, pnl: 50, pnlPct: 1 }, 'USD', date)).toBe('Open · +50.00 USD (+1.00%)');
    expect(outcomeLabel({ kind: 'ended', ts: T0 + DAY, price: 99, pnl: -50, pnlPct: -1 }, 'USD', date)).toBe('Ended, no hit · -50.00 USD (-1.00%) · 2024-01-02');
    expect(outcomeLabel({ kind: 'pending' }, 'USD', date)).toBeNull();
  });
});

describe('drag semantics (performEventPressedMove)', () => {
  const pts = () => toPositionPoints(g) as Array<{ timestamp?: number; value?: number }>;

  it('target edge: only the target changes (rounded, start time kept, never across the entry)', () => {
    const p = pts();
    p[1] = { timestamp: T0 + 3 * DAY, value: 105.678 };
    pressedMove('long', p, 1, 2, DAY);
    expect(fromPositionPoints(p)).toEqual({ ...g, target: 105.68 });
    p[1]!.value = 90;
    pressedMove('long', p, 1, 2, DAY);
    expect(p[1]!.value).toBe(100.01);
    const s = toPositionPoints(short) as typeof p;
    s[1]!.value = 101;
    pressedMove('short', s, 1, 2, DAY);
    expect(s[1]!.value).toBe(99.99);
  });

  it('stop edge: only the stop changes (clamped on its side of the entry)', () => {
    const p = pts();
    p[2] = { timestamp: T0 + DAY, value: 95.001 };
    pressedMove('long', p, 2, 2, DAY);
    expect(fromPositionPoints(p)).toEqual({ ...g, stop: 95 });
    p[2]!.value = 120;
    pressedMove('long', p, 2, 2, DAY);
    expect(p[2]!.value).toBe(99.99);
    const s = toPositionPoints(short) as typeof p;
    s[2]!.value = 50;
    pressedMove('short', s, 2, 2, DAY);
    expect(s[2]!.value).toBe(100.01);
  });

  it('entry handle: the whole position moves (prices and times together)', () => {
    const p = pts();
    p[0] = { timestamp: T0 + 2 * DAY, value: 110.004 };
    pressedMove('long', p, 0, 2, DAY);
    expect(fromPositionPoints(p)).toEqual({ start: T0 + 2 * DAY, end: T0 + 22 * DAY, entry: 110, target: 112, stop: 108 });
  });

  it('right edge: only the end time changes, never before start + one bar', () => {
    const p = pts();
    p[3] = { timestamp: T0 + 30 * DAY, value: 120 };
    pressedMove('long', p, 3, 2, DAY);
    expect(fromPositionPoints(p)).toEqual({ ...g, end: T0 + 30 * DAY });
    p[3]!.timestamp = T0 - 5 * DAY;
    pressedMove('long', p, 3, 2, DAY);
    expect(p[3]!.timestamp).toBe(T0 + DAY);
  });

  it('is a no-op on valid points (KLineChart runs it when points are set programmatically) and on incomplete ones', () => {
    const p = pts();
    pressedMove('long', p, 3, 2, DAY);
    expect(p).toEqual(toPositionPoints(g));
    const few = [{ timestamp: 1, value: 1 }];
    pressedMove('long', few, 0, 2, DAY);
    expect(few).toEqual([{ timestamp: 1, value: 1 }]);
  });
});

describe('endAfterBars (default width ≈ 20 bars)', () => {
  const ts = [0, 10, 20, 30, 40];
  it('counts bars in the data, extrapolating with the bar duration past the last bar', () => {
    expect(endAfterBars(ts, 10, 2, 10)).toBe(30);
    expect(endAfterBars(ts, 20, 5, 10)).toBe(70);
    expect(endAfterBars(ts, 15, 1, 10)).toBe(20); // inside bar 10 → one bar later
    expect(endAfterBars([], 100, 20, 5)).toBe(200);
    expect(endAfterBars(ts, 100, 3, 10)).toBe(130); // after the data
  });
});

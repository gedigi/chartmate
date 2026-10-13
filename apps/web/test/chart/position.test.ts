import { describe, expect, it } from 'vitest';
import {
  centreLabel, defaultGeometry, distancePct, distanceTicks, endAfterBars, evaluateOutcome, formatAmount, formatPct, fromPositionPoints,
  nextBarTime, outcomeLabel, positionMetrics, pressedMove, shiftByBars, priceFromPct, priceFromTicks, qtyDecimals, riskAmount, sideOf, stopLabel, targetLabel,
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
    expect(formatAmount(-0.004, 'USD')).toBe('+0.00 USD'); // no "-0.00"
    expect(formatAmount(-0, 'USD')).toBe('+0.00 USD');
    expect(formatPct(-0)).toBe('+0.00%');
    expect(formatPct(-0.001)).toBe('+0.00%');
  });
});

describe('outcome: fill on entry touch, then target / stop on the following bars', () => {
  // bar(i, open, high, low, close): bar i days after T0.
  const bar = (i: number, open: number, high: number, low: number, close = (high + low) / 2) => ({ timestamp: T0 + i * DAY, open, high, low, close });
  const opts = { historyComplete: true };

  it('fills on the first bar at or after the start whose range touches the entry; hits are checked from the next bar', () => {
    // Bar 0 touches 100 and also reaches the target: intrabar order unknown, the target counts on later bars only.
    const bars = [bar(0, 99, 103, 99.5), bar(1, 101, 101.5, 99.5), bar(2, 101, 102.5, 100.5), bar(3, 90, 91, 80)];
    expect(evaluateOutcome(bars, 'long', g, 50, opts)).toEqual({ kind: 'target', fillTs: T0, ts: T0 + 2 * DAY, price: 102, pnl: 100, pnlPct: 2 });
  });

  it('waits for the entry: bars that never touch it, and a bar that only contains the start (began before it), do not fill', () => {
    const mid = { ...g, start: T0 + DAY / 2 };
    // Bar 0 began before the start → excluded; bar 1 does not touch 100.
    const bars = [bar(0, 100, 101, 99), bar(1, 105, 106, 104)];
    expect(evaluateOutcome(bars, 'long', mid, 50, opts)).toEqual({ kind: 'waiting' });
    expect(evaluateOutcome([], 'long', g, 50, opts)).toEqual({ kind: 'waiting' });
    expect(evaluateOutcome([bar(-1, 100, 101, 99)], 'long', g, 50, opts)).toEqual({ kind: 'waiting' }); // future start
  });

  it('range over without touching the entry: unfilled', () => {
    expect(evaluateOutcome([bar(1, 105, 106, 104), bar(21, 100, 101, 99)], 'long', g, 50, opts)).toEqual({ kind: 'unfilled' });
  });

  it('needs earlier data when the start lies before the first loaded bar and older bars exist', () => {
    const bars = [bar(5, 100, 101, 99), bar(6, 100, 103, 99.5)];
    expect(evaluateOutcome(bars, 'long', g, 50, { historyComplete: false })).toEqual({ kind: 'needsData' });
    expect(evaluateOutcome(bars, 'long', g, 50)).toEqual({ kind: 'needsData' }); // unknown → assume more exists
    // No older data at all (provider limit): evaluated on what exists.
    expect(evaluateOutcome(bars, 'long', g, 50, opts)).toMatchObject({ kind: 'target', fillTs: T0 + 5 * DAY });
  });

  it('stop hit (long); both levels in the same later bar → stop first (conservative)', () => {
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 99, 101, 97.5)], 'long', g, 50, opts))
      .toEqual({ kind: 'stop', fillTs: T0, ts: T0 + DAY, price: 98, pnl: -100, pnlPct: -2 });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 100, 103, 97)], 'long', g, 50, opts)).toMatchObject({ kind: 'stop' });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 100, 103, 97)], 'short', short, 50, opts)).toMatchObject({ kind: 'stop', pnl: -100 });
  });

  it('short: target when the low reaches it, stop when the high does', () => {
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 100, 100.5, 97.9)], 'short', short, 50, opts))
      .toEqual({ kind: 'target', fillTs: T0, ts: T0 + DAY, price: 98, pnl: 100, pnlPct: 2 });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 101, 102, 99)], 'short', short, 50, opts)).toMatchObject({ kind: 'stop', price: 102, pnl: -100 });
  });

  it('gaps: a bar opening beyond the stop books the loss at the open; beyond the target the gain stays at the target', () => {
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 96, 97, 95)], 'long', g, 50, opts))
      .toMatchObject({ kind: 'stop', price: 96, pnl: -200, pnlPct: -4 });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 105, 106, 104)], 'long', g, 50, opts))
      .toMatchObject({ kind: 'target', price: 102, pnl: 100 });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 104, 105, 103)], 'short', short, 50, opts))
      .toMatchObject({ kind: 'stop', price: 104, pnl: -200 });
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(1, 95, 96, 94)], 'short', short, 50, opts))
      .toMatchObject({ kind: 'target', price: 98, pnl: 100 });
  });

  it('filled, no hit, last bar inside the range: open at the last close (also on the fill bar itself)', () => {
    expect(evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(2, 101, 101.5, 99.5, 101)], 'long', g, 50, opts))
      .toEqual({ kind: 'open', fillTs: T0, ts: T0 + 2 * DAY, price: 101, pnl: 50, pnlPct: 1 });
    expect(evaluateOutcome([bar(0, 100, 103, 99, 99)], 'short', short, 50, opts)).toMatchObject({ kind: 'open', pnl: 50, pnlPct: 1 });
  });

  it('filled, no hit up to the end time, later bars exist: ended at the last close in range', () => {
    const o = evaluateOutcome([bar(0, 100, 100.5, 99.5), bar(20, 100, 101, 99, 99), bar(21, 150, 200, 1)], 'long', g, 50, opts);
    expect(o).toMatchObject({ kind: 'ended', ts: T0 + 20 * DAY, price: 99, pnl: -50 });
  });

  it('outcome labels', () => {
    const date = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    const base = { fillTs: T0 };
    expect(outcomeLabel({ ...base, kind: 'target', ts: T0 + DAY, price: 102, pnl: 100, pnlPct: 2 }, 'USD', date)).toBe('Target hit · +100.00 USD (+2.00%) · 2024-01-02');
    expect(outcomeLabel({ ...base, kind: 'stop', ts: T0 + DAY, price: 98, pnl: -100, pnlPct: -2 }, 'USD', date)).toBe('Stop hit · -100.00 USD (-2.00%) · 2024-01-02');
    expect(outcomeLabel({ ...base, kind: 'open', ts: T0 + DAY, price: 101, pnl: 50, pnlPct: 1 }, 'USD', date)).toBe('Open · +50.00 USD (+1.00%)');
    expect(outcomeLabel({ ...base, kind: 'ended', ts: T0 + DAY, price: 99, pnl: -50, pnlPct: -1 }, 'USD', date)).toBe('Ended, no hit · -50.00 USD (-1.00%) · 2024-01-02');
    expect(outcomeLabel({ kind: 'waiting' }, 'USD', date)).toBe('Waiting for entry');
    expect(outcomeLabel({ kind: 'unfilled' }, 'USD', date)).toBe('Entry not reached');
    expect(outcomeLabel({ kind: 'needsData' }, 'USD', date)).toBe('Outcome needs earlier data');
  });
});

describe('drag semantics (performEventPressedMove)', () => {
  const pts = () => toPositionPoints(g) as Array<{ timestamp?: number; value?: number }>;
  // Daily bars T0 … T0 + 4 days, then a weekend gap to T0 + 7 days.
  const days = [0, 1, 2, 3, 4, 7, 8].map((d) => ({ timestamp: T0 + d * DAY }));
  const opts = {
    minEnd: (start: number) => nextBarTime(days, start, DAY),
    shiftEnd: (end: number, from: number, to: number) => shiftByBars(days, end, from, to, DAY),
    minGap: 0,
  };

  it('target edge: only the target changes (rounded, start time kept, never across the entry)', () => {
    const p = pts();
    p[1] = { timestamp: T0 + 3 * DAY, value: 105.678 };
    pressedMove('long', p, 1, 2, opts);
    expect(fromPositionPoints(p)).toEqual({ ...g, target: 105.68 });
    p[1]!.value = 90;
    pressedMove('long', p, 1, 2, opts);
    expect(p[1]!.value).toBe(100.01);
    const s = toPositionPoints(short) as typeof p;
    s[1]!.value = 101;
    pressedMove('short', s, 1, 2, opts);
    expect(s[1]!.value).toBe(99.99);
  });

  it('target / stop keep a minimum on-screen gap from the entry so the entry handle stays reachable, and stay positive', () => {
    const p = pts();
    p[1]!.value = 100.02;
    pressedMove('long', p, 1, 2, { ...opts, minGap: 0.5 });
    expect(p[1]!.value).toBe(100.5);
    const s = toPositionPoints(short) as typeof p;
    s[1]!.value = -5;
    pressedMove('short', s, 1, 2, opts);
    expect(s[1]!.value).toBe(0.01);
    const l = pts();
    l[2]!.value = -3;
    pressedMove('long', l, 2, 2, opts);
    expect(l[2]!.value).toBe(0.01);
  });

  it('stop edge: only the stop changes (clamped on its side of the entry)', () => {
    const p = pts();
    p[2] = { timestamp: T0 + DAY, value: 95.001 };
    pressedMove('long', p, 2, 2, opts);
    expect(fromPositionPoints(p)).toEqual({ ...g, stop: 95 });
    p[2]!.value = 120;
    pressedMove('long', p, 2, 2, opts);
    expect(p[2]!.value).toBe(99.99);
    const s = toPositionPoints(short) as typeof p;
    s[2]!.value = 50;
    pressedMove('short', s, 2, 2, opts);
    expect(s[2]!.value).toBe(100.01);
  });

  it('entry handle: the whole position moves; the end shifts by the same number of bars', () => {
    const p = toPositionPoints({ ...g, end: T0 + 3 * DAY }) as Array<{ timestamp?: number; value?: number }>;
    p[0] = { timestamp: T0 + 2 * DAY, value: 110.004 };
    pressedMove('long', p, 0, 2, opts);
    // 2 bars later: the end moves from bar 3 (T0+3d) to bar 5 (T0+7d, after the weekend).
    expect(fromPositionPoints(p)).toEqual({ start: T0 + 2 * DAY, end: T0 + 7 * DAY, entry: 110, target: 112, stop: 108 });
  });

  it('entry handle: a move that would take a price to zero or below keeps the prices (time still moves)', () => {
    const p = pts();
    p[0] = { timestamp: T0 + DAY, value: 1.5 };
    pressedMove('long', p, 0, 2, opts); // stop would be -0.5
    expect(fromPositionPoints(p)).toMatchObject({ start: T0 + DAY, entry: 100, target: 102, stop: 98 });
  });

  it('right edge: only the end time changes, never before the next bar after the start', () => {
    const p = pts();
    p[3] = { timestamp: T0 + 30 * DAY, value: 120 };
    pressedMove('long', p, 3, 2, opts);
    expect(fromPositionPoints(p)).toEqual({ ...g, end: T0 + 30 * DAY });
    p[3]!.timestamp = T0 - 5 * DAY;
    pressedMove('long', p, 3, 2, opts);
    expect(p[3]!.timestamp).toBe(T0 + DAY);
    // Start on the last bar before a weekend: the next bar is after it.
    const w = toPositionPoints({ ...g, start: T0 + 4 * DAY, end: T0 + 4 * DAY }) as typeof p;
    pressedMove('long', w, 3, 2, opts);
    expect(w[3]!.timestamp).toBe(T0 + 7 * DAY);
  });

  it('is a no-op on valid points (KLineChart runs it when points are set programmatically) and on incomplete ones', () => {
    const p = pts();
    pressedMove('long', p, 3, 2, opts);
    expect(p).toEqual(toPositionPoints(g));
    const few = [{ timestamp: 1, value: 1 }];
    pressedMove('long', few, 0, 2, opts);
    expect(few).toEqual([{ timestamp: 1, value: 1 }]);
  });
});

describe('bar helpers', () => {
  const ts = [0, 10, 20, 30, 40].map((timestamp) => ({ timestamp }));
  it('endAfterBars counts bars in the data, extrapolating with the bar duration past the last bar', () => {
    expect(endAfterBars(ts, 10, 2, 10)).toBe(30);
    expect(endAfterBars(ts, 20, 5, 10)).toBe(70);
    expect(endAfterBars(ts, 15, 1, 10)).toBe(20); // inside bar 10 → one bar later
    expect(endAfterBars([], 100, 20, 5)).toBe(200);
    expect(endAfterBars(ts, 100, 3, 10)).toBe(130); // after the data
  });

  it('nextBarTime: the first bar after a time, extrapolated past the data', () => {
    expect(nextBarTime(ts, 10, 10)).toBe(20);
    expect(nextBarTime(ts, 15, 10)).toBe(20);
    expect(nextBarTime(ts, 40, 10)).toBe(50);
    expect(nextBarTime([], 7, 10)).toBe(17);
  });

  it('shiftByBars moves a time by the bar distance between two times (extrapolated outside the data)', () => {
    expect(shiftByBars(ts, 30, 10, 20, 10)).toBe(40);
    expect(shiftByBars(ts, 30, 20, 0, 10)).toBe(10);
    expect(shiftByBars(ts, 40, 10, 30, 10)).toBe(60);
    expect(shiftByBars([], 100, 0, 30, 10)).toBe(130);
  });
});

import { describe, expect, it } from 'vitest';
import {
  alertKind, alertTargets, barIndexer, checkAlert, defaultAlert, FIB_LEVELS,
  type AlertContext, type AlertMemory, type DrawingAlert,
} from '../src/alerts.js';
import type { DrawingState } from '../src/types.js';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 0, 5); // a Monday
// Hourly bars with a gap (a "weekend"): positions 0..3, then 4..5 two days later.
const bars = [0, 1, 2, 3].map((i) => ({ ts: T0 + i * H })).concat([0, 1].map((i) => ({ ts: T0 + 2 * D + i * H })));
const index = barIndexer(bars, '1h');
const drawing = (name: string, points: Array<[number, number]>): DrawingState => ({ name, points: points.map(([timestamp, value]) => ({ timestamp, value })), lock: false });
const alert = (name: string, patch: Partial<DrawingAlert> = {}): DrawingAlert => ({ ...defaultAlert(name, 'a1', '1h', 'rth')!, ...patch });
const ctx = (price: number, now = T0): AlertContext => ({ ticker: 'AAPL', price, now, precision: 2 });

/** Runs prices through one alert; returns the notices (null when silent) and the last memory. */
function run(d: DrawingState, a: DrawingAlert, prices: number[], at = 5): { notices: Array<string | null>; memory: AlertMemory | undefined } {
  let memory: AlertMemory | undefined;
  const notices: Array<string | null> = [];
  for (const p of prices) {
    const r = checkAlert(d, a, alertTargets(d, a, index, at), memory, ctx(p));
    memory = r.memory;
    notices.push(r.notice?.title ?? null);
  }
  return { notices, memory };
}

describe('alert kinds and defaults', () => {
  it('every drawing tool but text has an alert', () => {
    expect(['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'priceLine'].map(alertKind)).toEqual(['line', 'line', 'line', 'line', 'line']);
    expect([alertKind('fibonacciLine'), alertKind('parallelChannel'), alertKind('rectangle'), alertKind('longPosition'), alertKind('verticalStraightLine')])
      .toEqual(['fib', 'zone', 'zone', 'position', 'time']);
    expect(alertKind('simpleAnnotation')).toBeNull();
    expect(defaultAlert('simpleAnnotation', 'x', '1h', 'rth')).toBeNull();
  });
  it('defaults: either way, channel breaks, entering a rectangle, 61.8 %, the whole trade; finite drawings extended', () => {
    expect(defaultAlert('segment', 'x', '1h', 'eth')).toEqual({ id: 'x', on: true, tf: '1h', session: 'eth', cross: ['up', 'down'], extend: true });
    expect(defaultAlert('rayLine', 'x', '1h', 'rth')).not.toHaveProperty('extend');
    expect(defaultAlert('parallelChannel', 'x', '1h', 'rth')?.zone).toEqual(['exitUp', 'exitDown']);
    expect(defaultAlert('rectangle', 'x', '1h', 'rth')?.zone).toEqual(['enter']);
    expect(defaultAlert('fibonacciLine', 'x', '1h', 'rth')?.levels).toEqual([0.618]);
    expect(defaultAlert('shortPosition', 'x', '1h', 'rth')?.position).toEqual(['entry', 'target', 'stop']);
  });
});

describe('barIndexer (as the chart maps times to bars)', () => {
  it('inside the data: the nearest bar; gaps count as no bars', () => {
    expect(index(T0)).toBe(0);
    expect(index(T0 + 3 * H)).toBe(3);
    expect(index(T0 + 2 * D)).toBe(4); // two days later, but the next bar
    expect(index(T0 + 3 * H + 20 * 60_000)).toBe(3);
  });
  it('outside: whole periods from the first or last bar', () => {
    expect(index(T0 + 2 * D + 1 * H + 3 * H)).toBe(8);
    expect(index(T0 - 2 * H)).toBe(-2);
    const monthly = barIndexer([{ ts: Date.UTC(2026, 0, 1) }, { ts: Date.UTC(2026, 1, 1) }], '1M');
    expect(monthly(Date.UTC(2026, 4, 1))).toBe(4);
  });
});

describe('alertTargets', () => {
  it('a trend line is measured per bar (across the gap), and extended past its end only for the alert', () => {
    const seg = drawing('segment', [[T0, 100], [T0 + 2 * H, 102]]); // +1 per bar
    expect(alertTargets(seg, alert('segment'), index, 5)).toEqual({ kind: 'line', value: 105 });
    expect(alertTargets(seg, alert('segment', { extend: false }), index, 5)).toBeNull();
    expect(alertTargets(seg, alert('segment', { extend: false }), index, 1)).toEqual({ kind: 'line', value: 101 });
  });
  it('a ray starts at its first point; an extended line is everywhere; horizontal lines have one price', () => {
    const ray = drawing('rayLine', [[T0 + 3 * H, 50], [T0 + 2 * D, 51]]);
    expect(alertTargets(ray, alert('rayLine'), index, 2)).toBeNull();
    expect(alertTargets(ray, alert('rayLine'), index, 5)).toEqual({ kind: 'line', value: 52 });
    expect(alertTargets(drawing('straightLine', [[T0 + 4 * H, 10], [T0 + 2 * D, 20]]), alert('straightLine'), index, 0)).toEqual({ kind: 'line', value: -20 });
    expect(alertTargets(drawing('horizontalStraightLine', [[T0, 99.5]]), alert('horizontalStraightLine'), index, 5)).toEqual({ kind: 'line', value: 99.5 });
    expect(alertTargets(drawing('priceLine', [[T0 + 2 * D, 99.5]]), alert('priceLine'), index, 3)).toBeNull();
  });
  it('a channel is the band between its two lines; a rectangle its prices while it lasts (or extended)', () => {
    const ch = drawing('parallelChannel', [[T0, 100], [T0 + 2 * H, 102], [T0, 96]]);
    expect(alertTargets(ch, alert('parallelChannel'), index, 5)).toEqual({ kind: 'zone', lower: 101, upper: 105 });
    const rect = drawing('rectangle', [[T0 + H, 120], [T0 + 2 * H, 110]]);
    expect(alertTargets(rect, alert('rectangle'), index, 5)).toEqual({ kind: 'zone', lower: 110, upper: 120 });
    expect(alertTargets(rect, alert('rectangle', { extend: false }), index, 5)).toBeNull();
    expect(alertTargets(rect, alert('rectangle'), index, 0)).toBeNull(); // before it starts
  });
  it('Fibonacci levels are the chart’s, between the two points; positions read their four points', () => {
    expect(FIB_LEVELS).toContain(0.618);
    const fib = drawing('fibonacciLine', [[T0, 200], [T0 + H, 100]]);
    expect(alertTargets(fib, alert('fibonacciLine', { levels: [0.618, 0.5, 0.42] }), index, 5))
      .toEqual({ kind: 'fib', levels: [{ level: 0.618, value: 161.8 }, { level: 0.5, value: 150 }] });
    const pos = drawing('longPosition', [[T0, 100], [T0, 110], [T0, 95], [T0 + H, 100]]);
    expect(alertTargets(pos, alert('longPosition'), index, 5)).toEqual({ kind: 'position', side: 'long', entry: 100, target: 110, stop: 95 });
  });
});

describe('checkAlert', () => {
  const hline = drawing('horizontalStraightLine', [[T0, 100]]);

  it('a crossing fires once; the first price only records the side (drawing a line never fires at once)', () => {
    expect(run(hline, alert('horizontalStraightLine'), [101, 102, 99, 98, 101]).notices)
      .toEqual([null, null, 'AAPL crossed below the horizontal line', null, null]);
  });
  it('only the chosen direction fires; touching the line is no crossing', () => {
    expect(run(hline, alert('horizontalStraightLine', { cross: ['up'] }), [101, 99, 100, 101]).notices)
      .toEqual([null, null, null, 'AAPL crossed above the horizontal line']);
  });
  it('switched off, nothing fires; any change to the drawing or the alert starts over', () => {
    expect(run(hline, alert('horizontalStraightLine', { on: false }), [101, 99]).notices).toEqual([null, null]);
    const { memory } = run(hline, alert('horizontalStraightLine'), [101, 99]);
    expect(memory?.fired?.message).toBe('crossed below the horizontal line');
    const moved = drawing('horizontalStraightLine', [[T0, 90]]);
    const again = checkAlert(moved, alert('horizontalStraightLine'), alertTargets(moved, alert('horizontalStraightLine'), index, 5), memory, ctx(85));
    expect(again.memory.fired).toBeUndefined(); // re-armed; this first price only records the side
    expect(again.notice).toBeNull();
  });
  it('the notice says what happened and where, with the symbol’s precision', () => {
    const r = checkAlert(hline, alert('horizontalStraightLine'), { kind: 'line', value: 100 }, { key: '', sides: {} }, ctx(99));
    expect(r.notice).toBeNull(); // the memory key did not match: first sight again
    const m = checkAlert(hline, alert('horizontalStraightLine'), { kind: 'line', value: 100 }, undefined, ctx(101)).memory;
    expect(checkAlert(hline, alert('horizontalStraightLine'), { kind: 'line', value: 100 }, m, ctx(99.5)).notice)
      .toEqual({ title: 'AAPL crossed below the horizontal line', body: 'Price 99.50 · horizontal line at 100.00 · 1h' });
  });
  it('Fibonacci: the first watched level crossed', () => {
    const fib = drawing('fibonacciLine', [[T0, 200], [T0 + H, 100]]);
    expect(run(fib, alert('fibonacciLine', { levels: [0.618, 0.5] }), [140, 155]).notices).toEqual([null, 'AAPL crossed above the 50% level']);
  });
  it('channels: breaks above or below, entering only when asked', () => {
    const ch = drawing('parallelChannel', [[T0, 100], [T0 + 2 * H, 102], [T0, 96]]); // band 101–105 at bar 5
    expect(run(ch, alert('parallelChannel'), [103, 104, 106]).notices).toEqual([null, null, 'AAPL broke above the channel']);
    expect(run(ch, alert('parallelChannel'), [106, 103]).notices).toEqual([null, null]); // re-entering: not asked
    expect(run(ch, alert('parallelChannel', { zone: ['enter'] }), [106, 103]).notices).toEqual([null, 'AAPL entered the channel']);
    expect(run(ch, alert('parallelChannel'), [103, 99]).notices).toEqual([null, 'AAPL broke below the channel']);
  });
  it('rectangles: entering, leaving above or below', () => {
    const rect = drawing('rectangle', [[T0 + H, 120], [T0 + 2 * H, 110]]);
    expect(run(rect, alert('rectangle'), [125, 118]).notices).toEqual([null, 'AAPL entered the rectangle']);
    expect(run(rect, alert('rectangle', { zone: ['exitDown'] }), [115, 105]).notices).toEqual([null, 'AAPL left the rectangle below']);
  });
  it('positions: the entry, then the target or the stop, with the result in R', () => {
    const pos = drawing('longPosition', [[T0, 100], [T0, 110], [T0, 95], [T0 + H, 100]]);
    expect(run(pos, alert('longPosition'), [101, 99.5, 104, 110.2]).notices)
      .toEqual([null, 'AAPL long: entry reached', null, 'AAPL long: target hit (+2.0R)']);
    expect(run(pos, alert('longPosition'), [99, 100.5, 94]).notices).toEqual([null, 'AAPL long: entry reached', 'AAPL long: stop hit (−1.0R)']);
    // Without the entry notice, the trade is still followed.
    expect(run(pos, alert('longPosition', { position: ['stop'] }), [101, 99, 94]).notices).toEqual([null, null, 'AAPL long: stop hit (−1.0R)']);
    const short = drawing('shortPosition', [[T0, 100], [T0, 90], [T0, 105], [T0 + H, 100]]);
    expect(run(short, alert('shortPosition'), [99, 101, 89]).notices).toEqual([null, 'AAPL short: entry reached', 'AAPL short: target hit (+2.0R)']);
  });
  it('a vertical line: its time arriving', () => {
    const v = drawing('verticalStraightLine', [[T0 + 2 * H, 0]]);
    const a = alert('verticalStraightLine');
    let m = checkAlert(v, a, alertTargets(v, a, index, 5), undefined, ctx(1, T0 + H)).memory;
    const r = checkAlert(v, a, alertTargets(v, a, index, 5), m, ctx(1, T0 + 2 * H));
    expect(r.notice?.title).toBe('AAPL reached 2026-01-05 02:00 UTC');
    m = checkAlert(v, a, alertTargets(v, a, index, 5), undefined, ctx(1, T0 + 3 * H)).memory; // set after its time
    expect(checkAlert(v, a, alertTargets(v, a, index, 5), m, ctx(1, T0 + 4 * H)).notice).toBeNull();
  });
});

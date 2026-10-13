import type { AssetClass, PositionDefaults } from '@altv/shared';
import { roundPrice } from './drawingTemplates';

/**
 * Long / short position drawings (pure logic: geometry, drag rules, risk / quantity, labels, outcome).
 *
 * Points schema (stored in DrawingState.points, in this order):
 *   [0] { start time, entry price }   entry handle (left end of the entry line)
 *   [1] { start time, target price }  target handle (left end of the target edge)
 *   [2] { start time, stop price }    stop handle (left end of the stop edge)
 *   [3] { end time,   entry price }   right-edge handle (right end of the entry line)
 * Points 1–2 repeat the start time and point 3 the entry price, so every point is a plain time/price point
 * (anchoring, KLineChart's whole-drawing drag and the server schema treat them like any drawing's points).
 */

export type PositionSide = 'long' | 'short';
export interface PositionGeometry { start: number; end: number; entry: number; target: number; stop: number }
type Pt = { timestamp?: number; value?: number; dataIndex?: number };

export const DEFAULT_TARGET_PCT = 2;
export const DEFAULT_STOP_PCT = 2;
export const DEFAULT_WIDTH_BARS = 20;

export function sideOf(name: string): PositionSide | null {
  return name === 'longPosition' ? 'long' : name === 'shortPosition' ? 'short' : null;
}

export function toPositionPoints(g: PositionGeometry): Array<{ timestamp: number; value: number }> {
  return [
    { timestamp: g.start, value: g.entry }, { timestamp: g.start, value: g.target },
    { timestamp: g.start, value: g.stop }, { timestamp: g.end, value: g.entry },
  ];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function fromPositionPoints(points: ReadonlyArray<Pt | undefined>): PositionGeometry | null {
  const [e, t, s, end] = points;
  if (!e || !t || !s || !end) return null;
  if (!num(e.timestamp) || !num(e.value) || !num(t.timestamp) || !num(t.value) || !num(s.timestamp) || !num(s.value) || !num(end.timestamp) || !num(end.value)) return null;
  return { start: e.timestamp, end: end.timestamp, entry: e.value, target: t.value, stop: s.value };
}

/** +1 for a long position (gains when the price rises), −1 for a short one. */
const dir = (side: PositionSide) => (side === 'long' ? 1 : -1);

/** A new position at `entry`: target and stop ±2 % (short inverted), rounded to the price precision. */
export function defaultGeometry(side: PositionSide, start: number, entry: number, end: number, precision: number): PositionGeometry {
  const e = roundPrice(entry, precision);
  return {
    start, end, entry: e,
    target: priceFromPct(side, 'target', e, DEFAULT_TARGET_PCT, precision),
    stop: priceFromPct(side, 'stop', e, DEFAULT_STOP_PCT, precision),
  };
}

/** Error message for entry / target / stop prices, or null when valid (long: stop < entry < target; short inverted). */
export function validatePrices(side: PositionSide, p: Pick<PositionGeometry, 'entry' | 'target' | 'stop'>): string | null {
  if (![p.entry, p.target, p.stop].every((v) => num(v) && v > 0)) return 'Prices must be positive numbers';
  if (side === 'long') {
    if (!(p.target > p.entry)) return 'Target must be above the entry';
    if (!(p.stop < p.entry)) return 'Stop must be below the entry';
  } else {
    if (!(p.target < p.entry)) return 'Target must be below the entry';
    if (!(p.stop > p.entry)) return 'Stop must be above the entry';
  }
  return null;
}

export const tickSize = (precision: number) => 10 ** -precision;

/** Distance of `price` from `entry` in % of the entry (always positive). */
export function distancePct(_side: PositionSide, entry: number, price: number): number {
  return (Math.abs(price - entry) / entry) * 100;
}

/** Distance of `price` from `entry` in ticks (rounded). */
export function distanceTicks(entry: number, price: number, precision: number): number {
  return Math.round(Math.abs(price - entry) / tickSize(precision));
}

/** +1 when `kind` lies above the entry for `side` (long target, short stop), else −1. */
const above = (side: PositionSide, kind: 'target' | 'stop') => (kind === 'target' ? dir(side) : -dir(side));

/** The target / stop price `pct` % away from the entry on its side (rounded). */
export function priceFromPct(side: PositionSide, kind: 'target' | 'stop', entry: number, pct: number, precision: number): number {
  return roundPrice(entry * (1 + (above(side, kind) * pct) / 100), precision);
}

/** The target / stop price `ticks` ticks away from the entry on its side. */
export function priceFromTicks(side: PositionSide, kind: 'target' | 'stop', entry: number, ticks: number, precision: number): number {
  return roundPrice(entry + above(side, kind) * ticks * tickSize(precision), precision);
}

// ── risk / quantity ──

/** Quantity decimals: whole shares for stocks (and baskets), up to 6 decimals for crypto. */
export function qtyDecimals(assetClass: AssetClass | null | undefined): number {
  return assetClass === 'crypto' ? 6 : 0;
}

/** The money at risk: a percentage of the account or a fixed amount. */
export function riskAmount(s: PositionDefaults): number {
  return s.riskMode === 'percent' ? (s.accountSize * s.riskValue) / 100 : s.riskValue;
}

export interface PositionMetrics {
  /** risk / |entry − stop|, floored to the quantity decimals. */
  qty: number;
  /** qty × |entry − stop| (the money actually at risk at that quantity). */
  riskAmount: number;
  /** qty × |target − entry|. */
  rewardAmount: number;
  /** |target − entry| / |entry − stop|. */
  rr: number;
  /** Target / stop distance in % of the entry (positive). */
  targetPct: number;
  stopPct: number;
}

function floorTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return roundPrice(Math.floor(v * f + 1e-9) / f, decimals);
}

export function positionMetrics(side: PositionSide, g: PositionGeometry, s: PositionDefaults, decimals: number): PositionMetrics {
  const risk = Math.abs(g.entry - g.stop);
  const reward = Math.abs(g.target - g.entry);
  const qty = risk > 0 ? floorTo(riskAmount(s) / risk, decimals) : 0;
  return {
    qty,
    riskAmount: qty * risk,
    rewardAmount: qty * reward,
    rr: risk > 0 ? reward / risk : 0,
    targetPct: distancePct(side, g.entry, g.target),
    stopPct: distancePct(side, g.entry, g.stop),
  };
}

// ── labels ──

const signOf = (v: number) => (v < 0 && Math.abs(v) >= 0.005 ? '-' : '+');

/** Signed amount with two decimals; values that round to zero (also -0) show as "+0.00". */
export function formatAmount(v: number, currency: string): string {
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${signOf(v)}${abs} ${currency}`;
}

export function formatPct(v: number): string {
  return `${signOf(v)}${Math.abs(v).toFixed(2)}%`;
}

export function formatQty(q: number): string {
  return q.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** "Target: 102.00 (+2.00%) +100.00 USD": the % and amount are the position's gain at the target. */
export function targetLabel(g: PositionGeometry, m: PositionMetrics, precision: number, currency: string): string {
  return `Target: ${g.target.toFixed(precision)} (${formatPct(m.targetPct)}) ${formatAmount(m.rewardAmount, currency)}`;
}

/** "Stop: 98.00 (-2.00%) -100.00 USD": the % and amount are the position's loss at the stop. */
export function stopLabel(g: PositionGeometry, m: PositionMetrics, precision: number, currency: string): string {
  return `Stop: ${g.stop.toFixed(precision)} (${formatPct(-m.stopPct)}) ${formatAmount(-m.riskAmount, currency)}`;
}

export function centreLabel(side: PositionSide, m: Pick<PositionMetrics, 'qty' | 'rr'>): string {
  return `${side === 'long' ? 'Long' : 'Short'} · Qty ${formatQty(m.qty)} · R:R ${m.rr.toFixed(2)}`;
}

// ── outcome ──

export interface OutcomeBar { timestamp: number; open: number; high: number; low: number; close: number }
/** A result with P&L: the fill bar's time, the bar of the hit (or of the last close used) and the exit price. */
export type PositionResult = { kind: 'target' | 'stop' | 'open' | 'ended'; fillTs: number; ts: number; price: number; pnl: number; pnlPct: number };
export type PositionOutcome =
  /** The loaded bars start after the position's start and older bars may exist: the outcome cannot be known yet. */
  | { kind: 'needsData' }
  /** No bar at or after the start has touched the entry (yet). */
  | { kind: 'waiting' }
  /** The time range is over and the entry was never touched. */
  | { kind: 'unfilled' }
  | PositionResult;

function result(kind: PositionResult['kind'], side: PositionSide, g: PositionGeometry, qty: number, fillTs: number, ts: number, price: number): PositionResult {
  const move = dir(side) * (price - g.entry);
  return { kind, fillTs, ts, price, pnl: qty * move, pnlPct: (move / g.entry) * 100 };
}

/** First index whose timestamp is > ts. */
function upperBound(bars: ReadonlyArray<{ timestamp: number }>, ts: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.timestamp <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The outcome over the bars (ascending, of the displayed timeframe), like TradingView:
 *  - Fill: the position opens on the first bar that starts at or after the start time and whose range touches the
 *    entry (low ≤ entry ≤ high); until then 'waiting' ('unfilled' once the range is over).
 *  - Hits: from the bar AFTER the fill bar (the order inside the fill bar is unknown, so a level also touched there
 *    counts only on later bars) up to the end time: target (long: high ≥ target, short: low ≤ target) or stop (long:
 *    low ≤ stop, short: high ≥ stop). A bar reaching both counts as a stop (conservative). A bar opening beyond the
 *    stop books the loss at its open (gap); one opening beyond the target still books the gain at the target.
 *  - Neither: 'open' at the last close when the last bar lies in the range, else 'ended' at the last close in range.
 *  - 'needsData' when the start lies before the first loaded bar and older bars may exist (`historyComplete` not true).
 */
export function evaluateOutcome(
  bars: ReadonlyArray<OutcomeBar>, side: PositionSide, g: PositionGeometry, qty: number, opts: { historyComplete?: boolean } = {},
): PositionOutcome {
  const first = bars[0];
  if (first && g.start < first.timestamp && opts.historyComplete !== true) return { kind: 'needsData' };
  let fill = -1;
  for (let i = upperBound(bars, g.start - 1); i < bars.length; i++) {
    const b = bars[i]!;
    if (b.timestamp > g.end) break;
    if (b.low <= g.entry && g.entry <= b.high) { fill = i; break; }
  }
  if (fill < 0) {
    const lastBar = bars[bars.length - 1];
    return lastBar && lastBar.timestamp > g.end ? { kind: 'unfilled' } : { kind: 'waiting' };
  }
  const fillTs = bars[fill]!.timestamp;
  let last = bars[fill]!;
  for (let j = fill + 1; j < bars.length; j++) {
    const b = bars[j]!;
    if (b.timestamp > g.end) break;
    if (side === 'long' ? b.low <= g.stop : b.high >= g.stop) {
      const price = side === 'long' ? Math.min(g.stop, b.open) : Math.max(g.stop, b.open);
      return result('stop', side, g, qty, fillTs, b.timestamp, price);
    }
    if (side === 'long' ? b.high >= g.target : b.low <= g.target) return result('target', side, g, qty, fillTs, b.timestamp, g.target);
    last = b;
  }
  const isLast = bars[bars.length - 1] === last;
  return result(isLast ? 'open' : 'ended', side, g, qty, fillTs, last.timestamp, last.close);
}

/** True for outcomes with a P&L (the position was filled). */
export const hasResult = (o: PositionOutcome): o is PositionResult =>
  o.kind === 'target' || o.kind === 'stop' || o.kind === 'open' || o.kind === 'ended';

export function outcomeLabel(o: PositionOutcome, currency: string, formatTime: (ts: number) => string): string {
  if (o.kind === 'needsData') return 'Outcome needs earlier data';
  if (o.kind === 'waiting') return 'Waiting for entry';
  if (o.kind === 'unfilled') return 'Entry not reached';
  const pnl = `${formatAmount(o.pnl, currency)} (${formatPct(o.pnlPct)})`;
  switch (o.kind) {
    case 'target': return `Target hit · ${pnl} · ${formatTime(o.ts)}`;
    case 'stop': return `Stop hit · ${pnl} · ${formatTime(o.ts)}`;
    case 'open': return `Open · ${pnl}`;
    case 'ended': return `Ended, no hit · ${pnl} · ${formatTime(o.ts)}`;
  }
}

// ── bar indexing (timestamps ascending; extrapolated with the bar duration outside the data) ──

type Stamped = ReadonlyArray<{ timestamp: number }>;

/** Index of the bar containing `ts` (the last bar at or before it); outside the data in whole bars (floored). */
function indexOf(bars: Stamped, ts: number, barMs: number): number {
  const i = upperBound(bars, ts) - 1;
  if (i < 0) return -Math.ceil((bars[0]!.timestamp - ts) / barMs);
  const last = bars.length - 1;
  if (i === last) return last + Math.floor((ts - bars[last]!.timestamp) / barMs);
  return i;
}

function timeAt(bars: Stamped, idx: number, barMs: number): number {
  const last = bars.length - 1;
  if (idx < 0) return bars[0]!.timestamp + idx * barMs;
  if (idx > last) return bars[last]!.timestamp + (idx - last) * barMs;
  return bars[idx]!.timestamp;
}

/** The time `n` bars after the bar containing `start` (no copy of the bar list is made). */
export function endAfterBars(bars: Stamped, start: number, n: number, barMs: number): number {
  if (bars.length === 0) return start + n * barMs;
  return timeAt(bars, indexOf(bars, start, barMs) + n, barMs);
}

/** The start of the bar after the one containing `ts` (e.g. Monday after a Friday for stocks). */
export function nextBarTime(bars: Stamped, ts: number, barMs: number): number {
  return endAfterBars(bars, ts, 1, barMs);
}

/** `ts` moved by as many bars as lie between `from` and `to`. */
export function shiftByBars(bars: Stamped, ts: number, from: number, to: number, barMs: number): number {
  if (bars.length === 0) return ts + (to - from);
  return timeAt(bars, indexOf(bars, ts, barMs) + indexOf(bars, to, barMs) - indexOf(bars, from, barMs), barMs);
}

// ── drag rules ──

export interface DragOptions {
  /** Earliest end of a position starting at `start` (the next bar). */
  minEnd: (start: number) => number;
  /** The end after the start moved from `from` to `to` (by the same number of bars). */
  shiftEnd: (end: number, from: number, to: number) => number;
  /** Smallest target / stop distance from the entry, in price (an on-screen gap keeping the entry handle reachable). */
  minGap: number;
}

function clampTarget(side: PositionSide, v: number, entry: number, gap: number, tick: number): number {
  return side === 'long' ? Math.max(v, entry + gap) : Math.max(tick, Math.min(v, entry - gap));
}

function clampStop(side: PositionSide, v: number, entry: number, gap: number, tick: number): number {
  return side === 'long' ? Math.max(tick, Math.min(v, entry - gap)) : Math.max(v, entry + gap);
}

/**
 * performEventPressedMove of the position overlays, after KLineChart moved point `index` (mutates `points`):
 *  - 0 (entry handle): the whole position moves: target and stop follow the entry's price change and the end moves
 *    by the same number of bars as the start; a move that would take a price to 0 or below keeps the prices;
 *  - 1 / 2 (target / stop edge): only that price changes, kept on its side of the entry (at least `minGap` and one
 *    tick away) and above zero;
 *  - 3 (right edge): only the end time changes, at least the next bar after the start.
 * Prices are rounded to `precision`. The redundant fields (start time on 1–2, entry price on 3) hold the state
 * before the move, so it is idempotent on valid points (KLineChart also runs it when points are set in code).
 */
export function pressedMove(side: PositionSide, points: Pt[], index: number, precision: number, opts: DragOptions): void {
  const [e, t, s, end] = points;
  if (!e || !t || !s || !end || !num(e.value) || !num(t.value) || !num(s.value) || !num(end.value)) return;
  const tick = tickSize(precision);
  const gap = Math.max(tick, opts.minGap);
  const r = (v: number) => roundPrice(v, precision);
  if (index === 0) {
    const entry = r(e.value);
    const dv = entry - end.value;
    const target = r(t.value + dv);
    const stop = r(s.value + dv);
    if (num(e.timestamp) && num(t.timestamp) && num(end.timestamp) && e.timestamp !== t.timestamp) {
      end.timestamp = opts.shiftEnd(end.timestamp, t.timestamp, e.timestamp);
    }
    if (Math.min(entry, target, stop) > 0) {
      e.value = entry;
      t.value = target;
      s.value = stop;
    } else {
      e.value = end.value; // prices unchanged
    }
  } else if (index === 1) {
    t.value = r(clampTarget(side, r(t.value), e.value, gap, tick));
  } else if (index === 2) {
    s.value = r(clampStop(side, r(s.value), e.value, gap, tick));
  }
  if (num(e.timestamp)) {
    t.timestamp = e.timestamp;
    s.timestamp = e.timestamp;
    if (num(end.timestamp)) {
      const min = opts.minEnd(e.timestamp);
      if (end.timestamp < min) end.timestamp = min;
    }
  }
  end.value = e.value;
}

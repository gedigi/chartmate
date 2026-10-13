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

export function formatAmount(v: number, currency: string): string {
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : '+'}${abs} ${currency}`;
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

export interface OutcomeBar { timestamp: number; high: number; low: number; close: number }
export type PositionOutcome =
  | { kind: 'pending' }
  | { kind: 'target' | 'stop' | 'open' | 'ended'; ts: number; price: number; pnl: number; pnlPct: number };

function result(kind: 'target' | 'stop' | 'open' | 'ended', side: PositionSide, g: PositionGeometry, qty: number, ts: number, price: number): PositionOutcome {
  const move = dir(side) * (price - g.entry);
  return { kind, ts, price, pnl: qty * move, pnlPct: (move / g.entry) * 100 };
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
 * The outcome over the bars (ascending) after the entry bar up to the end time: the first bar reaching the target
 * (long: high ≥ target, short: low ≤ target) or the stop (long: low ≤ stop, short: high ≥ stop). A bar reaching
 * both counts as a stop (the order inside a bar is unknown: conservative). Neither: 'open' at the last close when
 * the last bar lies in the range, 'ended' at the last close in the range when later bars exist; 'pending' without
 * any bar after the entry. The entry is considered filled at the entry bar.
 */
export function evaluateOutcome(bars: ReadonlyArray<OutcomeBar>, side: PositionSide, g: PositionGeometry, qty: number): PositionOutcome {
  let last: OutcomeBar | null = null;
  for (let i = upperBound(bars, g.start); i < bars.length; i++) {
    const b = bars[i]!;
    if (b.timestamp > g.end) break;
    const stopHit = side === 'long' ? b.low <= g.stop : b.high >= g.stop;
    if (stopHit) return result('stop', side, g, qty, b.timestamp, g.stop);
    const targetHit = side === 'long' ? b.high >= g.target : b.low <= g.target;
    if (targetHit) return result('target', side, g, qty, b.timestamp, g.target);
    last = b;
  }
  if (!last) return { kind: 'pending' };
  const isLast = bars[bars.length - 1] === last;
  return result(isLast ? 'open' : 'ended', side, g, qty, last.timestamp, last.close);
}

export function outcomeLabel(o: PositionOutcome, currency: string, formatTime: (ts: number) => string): string | null {
  if (o.kind === 'pending') return null;
  const pnl = `${formatAmount(o.pnl, currency)} (${formatPct(o.pnlPct)})`;
  switch (o.kind) {
    case 'target': return `Target hit · ${pnl} · ${formatTime(o.ts)}`;
    case 'stop': return `Stop hit · ${pnl} · ${formatTime(o.ts)}`;
    case 'open': return `Open · ${pnl}`;
    case 'ended': return `Ended, no hit · ${pnl} · ${formatTime(o.ts)}`;
  }
}

// ── drag rules ──

function clampTarget(side: PositionSide, v: number, entry: number, tick: number): number {
  return side === 'long' ? Math.max(v, entry + tick) : Math.max(tick, Math.min(v, entry - tick));
}

function clampStop(side: PositionSide, v: number, entry: number, tick: number): number {
  return side === 'long' ? Math.max(tick, Math.min(v, entry - tick)) : Math.max(v, entry + tick);
}

/**
 * performEventPressedMove of the position overlays, after KLineChart moved point `index` (mutates `points`):
 *  - 0 (entry handle): the whole position moves: target, stop and end follow the entry's price / time change;
 *  - 1 / 2 (target / stop edge): only that price changes, kept on its side of the entry;
 *  - 3 (right edge): only the end time changes, at least one bar (`minWidthMs`) after the start.
 * Prices are rounded to `precision`. The redundant fields (start time on 1–2, entry price on 3) hold the state
 * before the move, so it is idempotent on valid points (KLineChart also runs it when points are set in code).
 */
export function pressedMove(side: PositionSide, points: Pt[], index: number, precision: number, minWidthMs: number): void {
  const [e, t, s, end] = points;
  if (!e || !t || !s || !end || !num(e.value) || !num(t.value) || !num(s.value) || !num(end.value)) return;
  const tick = tickSize(precision);
  const r = (v: number) => roundPrice(v, precision);
  if (index === 0) {
    const entry = r(e.value);
    const dv = entry - end.value;
    if (num(e.timestamp) && num(t.timestamp) && num(end.timestamp)) end.timestamp += e.timestamp - t.timestamp;
    e.value = entry;
    t.value = r(t.value + dv);
    s.value = r(s.value + dv);
  } else if (index === 1) {
    t.value = r(clampTarget(side, r(t.value), e.value, tick));
  } else if (index === 2) {
    s.value = r(clampStop(side, r(s.value), e.value, tick));
  }
  if (num(e.timestamp)) {
    t.timestamp = e.timestamp;
    s.timestamp = e.timestamp;
    if (num(end.timestamp) && end.timestamp < e.timestamp + minWidthMs) end.timestamp = e.timestamp + minWidthMs;
  }
  end.value = e.value;
}

/** The time `n` bars after the bar containing `start` (bar timestamps ascending; extrapolated with `barMs` past the data). */
export function endAfterBars(timestamps: ReadonlyArray<number>, start: number, n: number, barMs: number): number {
  if (timestamps.length === 0) return start + n * barMs;
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid]! <= start) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1; // last bar at or before start
  if (i < 0) return start + n * barMs;
  const last = timestamps.length - 1;
  if (i === last) return start + n * barMs;
  const j = i + n;
  return j <= last ? timestamps[j]! : timestamps[last]! + (j - last) * barMs;
}

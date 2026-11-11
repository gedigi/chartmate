import { tfMs } from './timeframes.js';
import type { DrawingState, SessionMode, Timeframe } from './types.js';

/**
 * Alerts on drawings: what each drawing can watch, where its lines are at the latest bar, and what a new price means
 * (a crossing, entering or leaving a zone, a position's entry, target or stop). Pure: the server feeds it bars and
 * prices and keeps each alert's memory between checks.
 *
 * Lines are measured the way the chart draws them: by bar position on the alert's timeframe (a trend line across a
 * weekend rises per bar, not per hour), with KLineChart's mapping of a time to a bar (the nearest bar inside the
 * data, whole bar periods past either end).
 */

export type CrossDirection = 'up' | 'down';
export type ZoneEvent = 'enter' | 'exitUp' | 'exitDown';
export type PositionEvent = 'entry' | 'target' | 'stop';

export interface DrawingAlert {
  /** Stable id: the alert's memory (fired or not) is kept under it. */
  id: string;
  /** Armed. Off keeps the settings. */
  on: boolean;
  /** Where the drawing is measured and priced: the chart's timeframe and session when the alert was set. */
  tf: Timeframe;
  session: SessionMode;
  /** Lines: the crossing directions watched (both: either way). */
  cross?: CrossDirection[];
  /** Channels and rectangles: entering, leaving above, leaving below. */
  zone?: ZoneEvent[];
  /** Fibonacci retracements: the levels watched (fractions, e.g. 0.618). */
  levels?: number[];
  /** Positions: entry reached, then target or stop hit. */
  position?: PositionEvent[];
  /** Trend lines, channels and rectangles: keep watching past the drawing's right end. */
  extend?: boolean;
}

export type AlertKind = 'line' | 'fib' | 'zone' | 'position' | 'time';

/** The levels of a Fibonacci retracement, as the chart draws them. */
export const FIB_LEVELS: readonly number[] = Object.freeze([1, 0.786, 0.618, 0.5, 0.382, 0.236, 0]);

const SLOPED = new Set(['segment', 'rayLine', 'straightLine']);
const HORIZONTAL = new Set(['horizontalStraightLine', 'priceLine', 'horizontalRayLine', 'horizontalSegment']);
const ZONES = new Set(['parallelChannel', 'parallelStraightLine', 'rectangle']);
/** Drawings that end on the right (an alert can extend them). */
const FINITE = new Set(['segment', 'horizontalSegment', 'parallelChannel', 'rectangle']);

/** What a drawing's alert watches; null: the drawing has no alert (text). */
export function alertKind(name: string): AlertKind | null {
  if (SLOPED.has(name) || HORIZONTAL.has(name)) return 'line';
  if (name === 'fibonacciLine') return 'fib';
  if (ZONES.has(name)) return 'zone';
  if (name === 'longPosition' || name === 'shortPosition') return 'position';
  if (name === 'verticalStraightLine') return 'time';
  return null;
}

/** Whether the alert can watch past the drawing's right end ("Extend for the alert"). */
export const alertExtends = (name: string): boolean => FINITE.has(name);

/** A new alert on a drawing, with the defaults: either way, breaks of a channel, entering a rectangle, 61.8 %, the whole trade. */
export function defaultAlert(name: string, id: string, tf: Timeframe, session: SessionMode): DrawingAlert | null {
  const kind = alertKind(name);
  if (!kind) return null;
  const a: DrawingAlert = { id, on: true, tf, session };
  if (kind === 'line') a.cross = ['up', 'down'];
  if (kind === 'fib') a.levels = [0.618];
  if (kind === 'zone') a.zone = name === 'rectangle' ? ['enter'] : ['exitUp', 'exitDown'];
  if (kind === 'position') a.position = ['entry', 'target', 'stop'];
  if (alertExtends(name)) a.extend = true;
  return a;
}

/** Bar positions of times on a timeframe, as the chart computes them (see the module comment). */
export function barIndexer(bars: ReadonlyArray<{ ts: number }>, tf: Timeframe): (ts: number) => number {
  const n = bars.length;
  const step = (from: number, to: number): number => {
    if (tf === '1M') {
      const a = new Date(from);
      const b = new Date(to);
      return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    }
    return Math.floor((to - from) / tfMs(tf));
  };
  return (ts) => {
    if (n === 0) return 0;
    const first = bars[0]!.ts;
    const last = bars[n - 1]!.ts;
    if (ts > last) return n - 1 + step(last, ts);
    if (ts < first) return step(first, ts);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.ts <= ts) lo = mid;
      else hi = mid;
    }
    return ts - bars[lo]!.ts <= bars[hi]!.ts - ts ? lo : hi;
  };
}

/** What a drawing is at the latest bar. null: not there (before its start, or past its end without extending). */
export type AlertTargets =
  | { kind: 'line'; value: number }
  | { kind: 'fib'; levels: Array<{ level: number; value: number }> }
  | { kind: 'zone'; lower: number; upper: number }
  | { kind: 'position'; side: 'long' | 'short'; entry: number; target: number; stop: number }
  | { kind: 'time'; at: number };

/** `index`: bar positions on the alert's timeframe; `at`: the latest bar's position. */
export function alertTargets(d: DrawingState, a: DrawingAlert, index: (ts: number) => number, at: number): AlertTargets | null {
  const p = d.points;
  const kind = alertKind(d.name);
  if (!kind || p.length === 0 || !p.every((x) => Number.isFinite(x.timestamp) && Number.isFinite(x.value))) return null;
  const extend = a.extend === true && alertExtends(d.name);
  if (kind === 'time') return { kind, at: p[0]!.timestamp };
  if (kind === 'position') {
    if (p.length < 4) return null;
    return { kind, side: d.name === 'longPosition' ? 'long' : 'short', entry: p[0]!.value, target: p[1]!.value, stop: p[2]!.value };
  }
  if (kind === 'fib') {
    if (p.length < 2) return null;
    const [a0, a1] = [p[0]!.value, p[1]!.value];
    return { kind, levels: (a.levels ?? []).filter((l) => FIB_LEVELS.includes(l)).map((level) => ({ level, value: a1 + (a0 - a1) * level })) };
  }
  if (d.name === 'rectangle') {
    if (p.length < 2) return null;
    const [i0, i1] = [index(p[0]!.timestamp), index(p[1]!.timestamp)];
    if (at < Math.min(i0, i1) || (!extend && at > Math.max(i0, i1))) return null;
    return { kind: 'zone', lower: Math.min(p[0]!.value, p[1]!.value), upper: Math.max(p[0]!.value, p[1]!.value) };
  }
  // Lines and channels: the line through the first two points, at the latest bar.
  const i0 = index(p[0]!.timestamp);
  const first = p[0]!.value;
  const horizontal = HORIZONTAL.has(d.name) || p.length < 2;
  const i1 = horizontal ? i0 : index(p[1]!.timestamp);
  if (!horizontal && i1 === i0) return null; // vertical: no price to cross
  const slope = horizontal ? 0 : (p[1]!.value - first) / (i1 - i0);
  const lineAt = (x: number) => first + slope * (x - i0);
  const [left, right] = [Math.min(i0, i1), Math.max(i0, i1)];
  const name = d.name;
  if (name === 'segment' || name === 'horizontalSegment' || name === 'parallelChannel') {
    if (at < left || (!extend && at > right)) return null;
  } else if (name === 'rayLine') {
    if (i1 >= i0 ? at < i0 : at > i0) return null;
  } else if (name === 'priceLine' || name === 'horizontalRayLine') {
    if (at < i0) return null;
  }
  if (ZONES.has(name)) {
    if (p.length < 3) return null;
    const other = lineAt(at) + (p[2]!.value - lineAt(index(p[2]!.timestamp)));
    return { kind: 'zone', lower: Math.min(lineAt(at), other), upper: Math.max(lineAt(at), other) };
  }
  return { kind: 'line', value: lineAt(at) };
}

type Side = 'above' | 'below' | 'inside';

/** What an alert remembers between checks. A new `key` (the drawing or its alert changed) starts over. */
export interface AlertMemory {
  key: string;
  /** Where the price was, per watched line (first sight only records it: drawing a line never fires at once). */
  sides?: Record<string, Side>;
  /** Positions: the entry was reached. */
  open?: { at: number; price: number };
  /** Fired (alerts fire once; re-arming clears this). */
  fired?: { at: number; message: string };
}

/** The memory key: any change to the drawing or its alert re-arms it. */
export function alertKey(d: DrawingState, a: DrawingAlert): string {
  return JSON.stringify([d.name, d.points.map((x) => [x.timestamp, x.value]), d.anchorTf ?? null, a]);
}

export interface AlertNotice { title: string; body: string }

export interface AlertContext {
  /** As shown: "AAPL", "BTC", or a basket's name. */
  ticker: string;
  price: number;
  /** The latest bar's time. */
  now: number;
  precision: number;
}

const TOOL_NAMES: Record<string, string> = {
  segment: 'trend line', rayLine: 'ray', straightLine: 'extended line', horizontalStraightLine: 'horizontal line',
  horizontalRayLine: 'horizontal ray', horizontalSegment: 'horizontal segment', priceLine: 'price line',
  parallelChannel: 'channel', parallelStraightLine: 'channel', rectangle: 'rectangle', fibonacciLine: 'Fibonacci retracement',
};

export function formatAlertPrice(v: number, precision: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

const pct = (level: number) => `${(level * 100).toFixed(1).replace(/\.0$/, '')}%`;

/**
 * One check: the price against the drawing. Returns the new memory and what to tell (at most one notice: the alert
 * fires once; a position tells its entry, then its target or stop).
 */
export function checkAlert(
  d: DrawingState, a: DrawingAlert, targets: AlertTargets | null, memory: AlertMemory | undefined, ctx: AlertContext,
): { memory: AlertMemory; notice: AlertNotice | null } {
  const key = alertKey(d, a);
  const mem: AlertMemory = memory?.key === key ? { ...memory, sides: { ...memory.sides } } : { key, sides: {} };
  if (!a.on || mem.fired || !targets) return { memory: mem, notice: null };
  const sides = mem.sides!;
  const price = ctx.price;
  const fmt = (v: number) => formatAlertPrice(v, ctx.precision);
  const tool = TOOL_NAMES[d.name] ?? 'drawing';
  const fire = (title: string, body: string) => {
    mem.fired = { at: ctx.now, message: title };
    return { memory: mem, notice: { title: `${ctx.ticker} ${title}`, body } };
  };
  /** The side of `price` against `value` (equal: unchanged), and the previous one (undefined at first sight). */
  const move = (id: string, value: number): { from?: Side; to: Side } => {
    const from = sides[id];
    const to: Side = price > value ? 'above' : price < value ? 'below' : (from ?? 'below');
    sides[id] = to;
    return { from, to };
  };

  if (targets.kind === 'time') {
    const id = 't';
    const from = sides[id];
    const to: Side = ctx.now >= targets.at ? 'above' : 'below';
    sides[id] = to;
    if (from === 'below' && to === 'above') {
      const when = new Date(targets.at).toISOString().slice(0, 16).replace('T', ' ');
      return fire(`reached ${when} UTC`, `Price ${fmt(price)} · ${a.tf}`);
    }
    return { memory: mem, notice: null };
  }

  if (targets.kind === 'line') {
    const { from, to } = move('l', targets.value);
    if (from && from !== to) {
      const dir: CrossDirection = to === 'above' ? 'up' : 'down';
      if ((a.cross ?? []).includes(dir)) {
        return fire(`crossed ${dir === 'up' ? 'above' : 'below'} the ${tool}`, `Price ${fmt(price)} · ${tool} at ${fmt(targets.value)} · ${a.tf}`);
      }
    }
    return { memory: mem, notice: null };
  }

  if (targets.kind === 'fib') {
    for (const { level, value } of targets.levels) {
      const { from, to } = move(`f${level}`, value);
      if (from && from !== to) {
        return fire(`crossed ${to === 'above' ? 'above' : 'below'} the ${pct(level)} level`, `Price ${fmt(price)} · ${pct(level)} at ${fmt(value)} · ${a.tf}`);
      }
    }
    return { memory: mem, notice: null };
  }

  if (targets.kind === 'zone') {
    const from = sides.z;
    const to: Side = price > targets.upper ? 'above' : price < targets.lower ? 'below' : 'inside';
    sides.z = to;
    if (!from || from === to) return { memory: mem, notice: null };
    const event: ZoneEvent = to === 'inside' ? 'enter' : to === 'above' ? 'exitUp' : 'exitDown';
    if (!(a.zone ?? []).includes(event)) return { memory: mem, notice: null };
    const range = `${fmt(targets.lower)}–${fmt(targets.upper)}`;
    const what = event === 'enter' ? `entered the ${tool}` : d.name === 'rectangle'
      ? `left the rectangle ${event === 'exitUp' ? 'above' : 'below'}` : `broke ${event === 'exitUp' ? 'above' : 'below'} the channel`;
    return fire(what, `Price ${fmt(price)} · ${tool} ${range} · ${a.tf}`);
  }

  // Positions: the entry first (crossing it from either side), then the target or the stop.
  const t = targets;
  const watch = new Set(a.position ?? []);
  const label = `${t.side === 'long' ? 'long' : 'short'}`;
  const r = (exit: number) => {
    const risk = Math.abs(t.entry - t.stop);
    if (risk === 0) return '';
    const v = ((exit - t.entry) * (t.side === 'long' ? 1 : -1)) / risk;
    return ` (${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R)`;
  };
  if (!mem.open) {
    const { from, to } = move('e', t.entry);
    if (!from || from === to) return { memory: mem, notice: null };
    mem.open = { at: ctx.now, price };
    if (!watch.has('target') && !watch.has('stop')) {
      return watch.has('entry') ? fire(`${label}: entry reached`, `Price ${fmt(price)} · entry ${fmt(t.entry)} · ${a.tf}`) : { memory: mem, notice: null };
    }
    if (watch.has('entry')) {
      return { memory: mem, notice: { title: `${ctx.ticker} ${label}: entry reached`, body: `Price ${fmt(price)} · entry ${fmt(t.entry)} · target ${fmt(t.target)} · stop ${fmt(t.stop)}` } };
    }
    return { memory: mem, notice: null };
  }
  const up = t.side === 'long' ? 1 : -1;
  if (watch.has('target') && (price - t.target) * up >= 0) {
    return fire(`${label}: target hit${r(t.target)}`, `Price ${fmt(price)} · target ${fmt(t.target)} · entry ${fmt(t.entry)}`);
  }
  if (watch.has('stop') && (price - t.stop) * up <= 0) {
    return fire(`${label}: stop hit${r(t.stop)}`, `Price ${fmt(price)} · stop ${fmt(t.stop)} · entry ${fmt(t.entry)}`);
  }
  return { memory: mem, notice: null };
}

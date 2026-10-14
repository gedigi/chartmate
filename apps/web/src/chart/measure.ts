import { registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';
import { zoneTint } from './color';
import { readableTextOn } from './contrast';
import { CHART_FONT, LABEL_RADIUS } from './theme';

/**
 * The Shift measure: an ephemeral box from a start point to an end point on the candle pane, tinted in the up / down
 * family (end price ≥ start price: up), with dashed guide arrows and a label (price change and percent, bars and time
 * span, volume over the range). Never a drawing: not saved, copied, locked or counted.
 */
export const MEASURE_OVERLAY = 'chartmateMeasure';

/** Magnet mode of a measure point, as for drawings: the toolbar magnet (weak), ⌘ / Ctrl held (strong). */
export type MeasureSnap = 'normal' | 'weak_magnet' | 'strong_magnet';
/** Distance (px) within which the weak magnet snaps to a bar's open / high / low / close (KLineChart's own default). */
export const WEAK_MAGNET_PX = 8;

/** A measure end: bar index (extrapolated outside the data), that bar's time, the price. */
export interface MeasurePoint { index: number; timestamp: number; value: number }

/** The numbers of a measurement (start → end). */
export interface MeasureStats {
  change: number;
  /** Change in percent of the start price; null when the start price is 0. */
  percent: number | null;
  /** Bars from start to end (negative leftward), counted on the actual bars. */
  bars: number;
  /** Absolute time between the two bars. */
  spanMs: number;
  /** Volume summed over the loaded bars covered (both ends included); null when they carry none. */
  volume: number | null;
  up: boolean;
}

type OhlcBar = { open: number; high: number; low: number; close: number };
type VolumeBar = { volume?: number | null };

const MINUS = '−';

/** `v` at `precision` decimals, signed with '+' / '−' (a true minus); no sign when it rounds to zero. */
export function formatSigned(v: number, precision: number): string {
  const abs = Math.abs(v).toFixed(precision);
  if (Number(abs) === 0) return abs;
  return `${v < 0 ? MINUS : '+'}${abs}`;
}

const MINUTE = 60_000;
const SPAN_UNITS: ReadonlyArray<[string, number]> = [['y', 365 * 1440], ['d', 1440], ['h', 60], ['m', 1]];

/** A time span in its two largest units, unsigned: "45m", "2h 30m", "3d 4h", "16d", "1y 35d". */
export function formatSpan(ms: number): string {
  let minutes = Math.floor(Math.abs(ms) / MINUTE);
  const parts: string[] = [];
  for (const [unit, size] of SPAN_UNITS) {
    const n = Math.floor(minutes / size);
    minutes -= n * size;
    if (n > 0 || parts.length > 0) parts.push(`${n}${unit}`);
    if (parts.length === 2) break;
  }
  const shown = parts.filter((p, i) => i === 0 || !p.startsWith('0'));
  return shown.length > 0 ? shown.join(' ') : '0m';
}

/** "1.23B", "45.6M", "7.8K", "950". */
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v * 100) / 100);
}

/** The numbers of the measurement `start` → `end` over the loaded `bars`. */
export function measureStats(start: MeasurePoint, end: MeasurePoint, bars: ReadonlyArray<VolumeBar>): MeasureStats {
  const change = end.value - start.value;
  const percent = start.value !== 0 ? (change / Math.abs(start.value)) * 100 : null;
  const from = Math.max(0, Math.min(start.index, end.index));
  const to = Math.min(bars.length - 1, Math.max(start.index, end.index));
  let volume = 0;
  let any = false;
  for (let i = from; i <= to; i++) {
    const v = bars[i]?.volume;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      volume += v;
      any = true;
    }
  }
  return {
    change, percent, bars: end.index - start.index, spanMs: Math.abs(end.timestamp - start.timestamp),
    volume: any ? volume : null, up: change >= 0,
  };
}

/** The label lines: "+1.50 (+0.46%)", "12 bars, 3d 4h", "Vol 1.23M" (the last only with volume). */
export function measureLines(s: MeasureStats, precision: number): string[] {
  const change = formatSigned(s.change, precision);
  const lines = [s.percent === null ? change : `${change} (${formatSigned(s.percent, 2)}%)`];
  const n = Math.abs(s.bars);
  const bars = `${s.bars < 0 ? MINUS : ''}${n} ${n === 1 ? 'bar' : 'bars'}`;
  lines.push(s.spanMs > 0 ? `${bars}, ${formatSpan(s.spanMs)}` : bars);
  if (s.volume !== null) lines.push(`Vol ${compact(s.volume)}`);
  return lines;
}

/**
 * The price a measure point takes at `raw` over `bar` (null: no bar there): unchanged in normal mode, the nearest of
 * open / high / low / close with the strong magnet, and that only within WEAK_MAGNET_PX with the weak one.
 */
export function snapValue(raw: number, bar: OhlcBar | null, mode: MeasureSnap, yOf: (v: number) => number): number {
  if (mode === 'normal' || !bar) return raw;
  const y = yOf(raw);
  let best = raw;
  let dist = Infinity;
  for (const v of [bar.open, bar.high, bar.low, bar.close]) {
    const d = Math.abs(yOf(v) - y);
    if (d < dist) { dist = d; best = v; }
  }
  return mode === 'strong_magnet' || dist <= WEAK_MAGNET_PX ? best : raw;
}

/** Box fill: a light tint of the direction's color (opaque-looking, the candles under it keep their colors). */
export const MEASURE_WEIGHT = 0.06;
export const MEASURE_ALPHA = 0.14;

export interface MeasureColors { fill: string; stroke: string; label: string; labelText: string }

/** Colors of a measurement: the up / down candle color (stroke and label), its tint on `bg` (fill), readable label text. */
export function measureColors(up: boolean, palette: { up: string; down: string; bg: string }): MeasureColors {
  const strong = up ? palette.up : palette.down;
  return { fill: zoneTint(strong, palette.bg, MEASURE_WEIGHT, MEASURE_ALPHA), stroke: strong, label: strong, labelText: readableTextOn(strong) };
}

/** What the overlay draws (its extendData). */
export interface MeasureView { lines: string[]; colors: MeasureColors; font?: string }

type Coord = { x: number; y: number };

const DASH = [4, 3];
const ARROW = 5;
const LABEL_SIZE = 12;
const LINE_HEIGHT = 16;
const PAD_X = 8;
const PAD_Y = 5;
/** Gap between the box edge and the label. */
const LABEL_GAP = 6;
/** Estimated glyph width (no canvas measuring in the figure callback): ≈ 0.6 em. */
const textWidth = (text: string) => text.length * LABEL_SIZE * 0.6;

/** An arrowhead at `to` pointing away from `from` (none when the guide is too short to carry one). */
function arrowHead(from: Coord, to: Coord, color: string): OverlayFigure | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < ARROW * 2) return null;
  const ux = dx / len;
  const uy = dy / len;
  const bx = to.x - ux * ARROW * 1.4;
  const by = to.y - uy * ARROW * 1.4;
  return {
    type: 'polygon', ignoreEvent: true,
    attrs: { coordinates: [to, { x: bx - uy * ARROW, y: by + ux * ARROW }, { x: bx + uy * ARROW, y: by - ux * ARROW }] },
    styles: { style: 'fill', color },
  } as OverlayFigure;
}

/**
 * Figures of a measurement between `coords[0]` (start) and `coords[1]` (end): the tinted box, a dashed horizontal guide
 * (time) and vertical guide (price) through its middle with arrowheads at the end, and the label beyond the end
 * price's edge (above an up box, below a down one; the other side when it does not fit), centered on the box and kept
 * inside the pane. Nothing takes mouse events.
 */
export function measureFigures(p: { coords: ReadonlyArray<Coord>; view: MeasureView; paneWidth: number; paneHeight: number }): OverlayFigure[] {
  const [a, b] = p.coords;
  if (!a || !b) return [];
  const { colors, lines } = p.view;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  const guide = { style: 'dashed', color: colors.stroke, size: 1, dashedValue: DASH };
  const h1 = { x: a.x, y: midY };
  const h2 = { x: b.x, y: midY };
  const v1 = { x: midX, y: a.y };
  const v2 = { x: midX, y: b.y };
  const figures: OverlayFigure[] = [
    { type: 'rect', ignoreEvent: true, attrs: { x: left, y: top, width: right - left, height: bottom - top }, styles: { style: 'fill', color: colors.fill } },
    { type: 'line', ignoreEvent: true, attrs: { coordinates: [h1, h2] }, styles: guide },
    { type: 'line', ignoreEvent: true, attrs: { coordinates: [v1, v2] }, styles: guide },
  ];
  for (const head of [arrowHead(h1, h2, colors.stroke), arrowHead(v1, v2, colors.stroke)]) if (head) figures.push(head);

  if (lines.length === 0) return figures;
  const width = Math.ceil(Math.max(...lines.map(textWidth)) + 2 * PAD_X);
  const height = lines.length * LINE_HEIGHT + 2 * PAD_Y;
  const paneW = Math.max(p.paneWidth, width);
  const paneH = Math.max(p.paneHeight, height);
  const up = b.y <= a.y;
  const above = top - LABEL_GAP - height;
  const below = bottom + LABEL_GAP;
  let y = up ? (above >= 0 ? above : below) : (below + height <= paneH ? below : above);
  y = Math.min(paneH - height, Math.max(0, y));
  const x = Math.min(paneW - width, Math.max(0, midX - width / 2));
  figures.push({
    type: 'rect', ignoreEvent: true, attrs: { x, y, width, height },
    styles: { style: 'fill', color: colors.label, borderRadius: LABEL_RADIUS },
  } as OverlayFigure);
  const family = p.view.font ?? CHART_FONT;
  lines.forEach((text, i) => {
    figures.push({
      type: 'text', ignoreEvent: true,
      attrs: { x: x + width / 2, y: y + PAD_Y + i * LINE_HEIGHT + (LINE_HEIGHT - LABEL_SIZE) / 2, text, align: 'center', baseline: 'top' },
      styles: {
        color: colors.labelText, size: LABEL_SIZE, family, weight: i === 0 ? '650' : '500',
        backgroundColor: 'transparent', borderSize: 0, borderColor: 'transparent', paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      },
    } as OverlayFigure);
  });
  return figures;
}

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];

const template: OverlayTemplate = {
  name: MEASURE_OVERLAY,
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay, bounding }: FigureParams) => {
    const view = overlay.extendData as MeasureView | null | undefined;
    if (!view || !Array.isArray(view.lines)) return [];
    return measureFigures({ coords: coordinates, view, paneWidth: bounding?.width ?? 0, paneHeight: bounding?.height ?? 0 });
  },
};

let registered = false;

/** Registers the measure overlay (once; `force` re-registers, for tests). */
export function registerMeasureOverlay(force = false): void {
  if (registered && !force) return;
  registered = true;
  registerOverlay(template);
}

import type { OverlayFigure, OverlayTemplate } from 'klinecharts';
import { drawingContext } from './drawingTemplates';
import { THEME_TOKENS } from './theme';

/**
 * The time-axis labels of a selected drawing spanning a time range (rectangles, long / short positions): a band
 * between its start and end times and a label at each end, the left one ending at its time and the right one
 * starting at its time, so they point away from each other and never cover the range. Both stay inside the axis;
 * when they would come closer than RANGE_MERGE_GAP (a narrow range, or one pushed back from an edge) they merge
 * into one "start – end" label centered on the range. Labels and band take the overlay's text / rect styles, as
 * KLineChart's own axis labels do.
 */

/** Closest the two labels may come (px) before they merge into one: a narrow range reads better as one label. */
export const RANGE_MERGE_GAP = 48;

export interface RangeLabel { x: number; text: string; align: 'left' | 'right' | 'center' }

/** "start – end"; an intraday range within one day names the day once ("Thu Oct 15 '26 · 07:15 – 09:30"). */
export function mergeRangeText(start: string, end: string): string {
  const sep = ' · ';
  const i = start.lastIndexOf(sep);
  const j = end.lastIndexOf(sep);
  if (i > 0 && j > 0 && start.slice(0, i) === end.slice(0, j)) return `${start} – ${end.slice(j + sep.length)}`;
  return `${start} – ${end}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the labels of a time range go on an axis `width` px wide: `x0` / `x1` are the pixels of `start` / `end`
 * (in any order), `measure` gives a label's full width (padding included).
 */
export function rangeLabels(p: {
  x0: number; x1: number; start: string; end: string; width: number; measure: (text: string) => number; gap?: number;
}): RangeLabel[] {
  const gap = p.gap ?? RANGE_MERGE_GAP;
  const [xl, left, xr, right] = p.x0 <= p.x1 ? [p.x0, p.start, p.x1, p.end] : [p.x1, p.end, p.x0, p.start];
  const single = (x: number, text: string): RangeLabel[] => {
    const w = p.measure(text);
    return [{ x: clamp(x, w / 2, p.width - w / 2), text, align: 'center' }];
  };
  if (left === right) return single((xl + xr) / 2, left);
  const wl = p.measure(left);
  const wr = p.measure(right);
  const leftEnd = clamp(xl, wl, p.width); // right edge of the left label
  const rightStart = clamp(xr, 0, p.width - wr); // left edge of the right label
  if (rightStart - leftEnd < gap) return single((xl + xr) / 2, mergeRangeText(left, right));
  return [{ x: leftEnd, text: left, align: 'right' }, { x: rightStart, text: right, align: 'left' }];
}

/** Air (px) kept between a range label and a time-axis tick label; a closer tick label is masked. */
const TICK_AIR = 6;
/** Margin (px) of a tick label's mask around its text. */
const MASK_PAD = 2;

/**
 * Masks (x and width, the axis' full height) hiding the time-axis tick labels that would show partly beside the
 * range labels (`measure` gives a label's full width): each tick whose text box (`measureTick` wide, centered on
 * its coord) overlaps a label's box or comes within TICK_AIR of it is covered whole, so no clipped tick text ("Ju",
 * "ug") peeks out next to a label.
 */
export function tickMasks(
  labels: readonly RangeLabel[], ticks: ReadonlyArray<{ coord: number; text: string }>, measure: (text: string) => number,
  measureTick: (text: string) => number = measure,
): Array<{ x: number; width: number }> {
  const boxes = labels.map((l) => {
    const w = measure(l.text);
    const left = l.align === 'right' ? l.x - w : l.align === 'left' ? l.x : l.x - w / 2;
    return [left, left + w] as const;
  });
  const masks: Array<{ x: number; width: number }> = [];
  for (const t of ticks) {
    const half = measureTick(t.text) / 2;
    const [l, r] = [t.coord - half, t.coord + half];
    if (boxes.some(([bl, br]) => l < br + TICK_AIR && r > bl - TICK_AIR)) masks.push({ x: l - MASK_PAD, width: r - l + 2 * MASK_PAD });
  }
  return masks;
}

type FigureParams = Parameters<NonNullable<OverlayTemplate['createXAxisFigures']>>[0];

let ctx2d: CanvasRenderingContext2D | null | undefined;
/** Width of `text` in `font` (canvas when available, else ≈ 0.6 em per character). */
function textWidth(text: string, size: number, family: string, weight: string): number {
  if (ctx2d === undefined) {
    try { ctx2d = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null; } catch { ctx2d = null; }
  }
  if (ctx2d) {
    ctx2d.font = `${weight} ${size}px ${family}`;
    const w = ctx2d.measureText(text).width;
    if (Number.isFinite(w) && w > 0) return w;
  }
  return text.length * size * 0.6;
}

/** The chart's date text of a timestamp (its crosshair format), ISO date when the chart has no formatter. */
function dateText(p: FigureParams, ts: number): string {
  let s: unknown;
  try {
    s = p.chart.getFormatter?.()?.formatDate?.({ dateTimeFormat: undefined as never, timestamp: ts, template: 'YYYY-MM-DD HH:mm', type: 'crosshair' });
  } catch { /* KLineChart's own formatter needs its date format: the ISO date below */ }
  return typeof s === 'string' && s !== '' ? s : new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Time-axis figures of a selected range drawing whose start / end are points `i0` / `i1` (nothing when it is not
 * selected: drawingContext.selectedId, set by the adapter).
 */
export function rangeAxisFigures(p: FigureParams, i0: number, i1: number): OverlayFigure[] {
  if (!p.overlay.id || p.overlay.id !== drawingContext.selectedId) return [];
  const t0 = p.overlay.points[i0]?.timestamp;
  const t1 = p.overlay.points[i1]?.timestamp;
  const c0 = p.coordinates[i0];
  const c1 = p.coordinates[i1];
  if (typeof t0 !== 'number' || typeof t1 !== 'number' || !c0 || !c1) return [];
  const text = (p.chart.getStyles?.()?.overlay?.text ?? {}) as Partial<Record<'size' | 'paddingLeft' | 'paddingRight' | 'family' | 'weight', unknown>>;
  const own = ((p.overlay.styles as { text?: Record<string, unknown> } | null | undefined)?.text ?? {});
  const size = typeof own.size === 'number' ? own.size : typeof text.size === 'number' ? text.size : 12;
  const family = String(own.family ?? text.family ?? 'sans-serif');
  const weight = String(own.weight ?? text.weight ?? 'normal');
  const pad = (Number(own.paddingLeft ?? text.paddingLeft) || 0) + (Number(own.paddingRight ?? text.paddingRight) || 0);
  const labelWidth = (s: string) => Math.ceil(textWidth(s, size, family, weight)) + pad;
  const labels = rangeLabels({
    x0: c0.x, x1: c1.x, start: dateText(p, t0), end: dateText(p, t1), width: p.bounding.width,
    measure: labelWidth,
  });
  const left = Math.min(c0.x, c1.x);
  // Tick labels the range labels would partly cover are masked with the chart background (drawn first, under the
  // band and the labels). They are measured in the axis' own tick font.
  const tick = (p.chart.getStyles?.()?.xAxis?.tickText ?? {}) as Partial<Record<'size' | 'family' | 'weight', unknown>>;
  const tickSize = typeof tick.size === 'number' ? tick.size : 11;
  const ticks = (p.xAxis as { getTicks?: () => Array<{ coord: number; text: unknown }> } | null)?.getTicks?.() ?? [];
  const masks = tickMasks(
    labels, ticks.map((t) => ({ coord: t.coord, text: String(t.text) })), labelWidth,
    (s) => textWidth(s, tickSize, String(tick.family ?? family), String(tick.weight ?? 'normal')),
  );
  const bg = drawingContext.bg || THEME_TOKENS[drawingContext.theme].bg;
  return [
    ...masks.map((m) => ({
      type: 'rect', ignoreEvent: true, attrs: { x: m.x, y: 0, width: m.width, height: p.bounding.height },
      styles: { style: 'fill', color: bg, borderSize: 0 },
    }) as OverlayFigure),
    { type: 'rect', ignoreEvent: true, attrs: { x: left, y: 0, width: Math.abs(c1.x - c0.x), height: p.bounding.height } } as OverlayFigure,
    ...labels.map((l) => ({ type: 'text', ignoreEvent: true, attrs: { x: l.x, y: 0, text: l.text, align: l.align } }) as OverlayFigure),
  ];
}

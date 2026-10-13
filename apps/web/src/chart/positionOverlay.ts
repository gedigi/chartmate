import { DEFAULT_POSITION_DEFAULTS, type PositionDefaults } from '@chartmate/shared';
import { registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';
import { readableTextOn } from './contrast';
import { drawingConstraint } from './drawingTemplates';
import {
  centerLabel, DEFAULT_WIDTH_BARS, defaultGeometry, evaluateOutcome, fromPositionPoints, hasResult, outcomeLabel, positionMetrics, pressedMove,
  sideOf, stopLabel, targetLabel, toPositionPoints, type OutcomeBar, type PositionGeometry, type PositionMetrics, type PositionOutcome,
  type PositionSide,
} from './position';
import { hexToRgba, THEME_TOKENS } from './theme';

/** Fill opacity of the profit / loss zones, and of the part already traversed by the price (outcome). */
export const ZONE_ALPHA = 0.2;
export const TRAVERSED_ALPHA = 0.4;
/** Smallest on-screen distance (px) between the entry handle and a dragged target / stop handle. */
export const HANDLE_GAP_PX = 12;

export interface PositionColors { up: string; down: string; neutral: string }

/**
 * Shared rendering / placement state of the position overlays (one chart per page), set by the ChartAdapter:
 * bar duration of the timeframe, the global target / stop defaults of new positions, theme colors, bar-time
 * helpers over the loaded data (default end, next bar, shifting by bars), whether older data exists, and the price
 * distance of HANDLE_GAP_PX (updated on every render from the y axis).
 */
export const positionContext: {
  barMs: number; defaults: PositionDefaults; colors: PositionColors;
  endFor: (start: number) => number;
  minEnd: (start: number) => number;
  shiftEnd: (end: number, from: number, to: number) => number;
  historyComplete: () => boolean;
  minGapPrice: number;
  formatTime: (ts: number) => string;
} = {
  barMs: 86_400_000,
  defaults: { ...DEFAULT_POSITION_DEFAULTS },
  colors: { up: THEME_TOKENS.dark.up, down: THEME_TOKENS.dark.down, neutral: THEME_TOKENS.dark.muted },
  endFor: (start) => start + DEFAULT_WIDTH_BARS * positionContext.barMs,
  minEnd: (start) => start + positionContext.barMs,
  shiftEnd: (end, from, to) => end + (to - from),
  historyComplete: () => true,
  minGapPrice: 0,
  formatTime: (ts) => new Date(ts).toISOString().slice(0, 10),
};

// ── memoized metrics / outcome ──

export interface PositionState { metrics: PositionMetrics; outcome: PositionOutcome }
const stateCache = new Map<string, { key: string; state: PositionState }>();
const MAX_CACHED = 500;

/**
 * Metrics and outcome of a position, recomputed only when its geometry, the data
 * (length, first bar, the last bar's values) or the history state change: the outcome scan runs once per change,
 * not on every repaint / mouse move.
 */
export function positionState(p: {
  id: string; side: PositionSide; g: PositionGeometry;
  bars: ReadonlyArray<OutcomeBar>; historyComplete: boolean; barMs: number;
}): PositionState {
  const first = p.bars[0];
  const last = p.bars[p.bars.length - 1];
  const key = [
    p.side, p.g.start, p.g.end, p.g.entry, p.g.target, p.g.stop,
    p.bars.length, first?.timestamp, last?.timestamp, last?.open, last?.high, last?.low, last?.close, p.historyComplete, p.barMs,
  ].join('|');
  const hit = stateCache.get(p.id);
  if (hit?.key === key) return hit.state;
  const metrics = positionMetrics(p.side, p.g);
  const outcome = evaluateOutcome(p.bars, p.side, p.g, { historyComplete: p.historyComplete });
  const state = { metrics, outcome };
  if (stateCache.size >= MAX_CACHED) stateCache.clear();
  stateCache.set(p.id, { key, state });
  return state;
}

// ── figures ──

type Coord = { x: number; y: number };

export interface PositionFigureInput {
  side: PositionSide; g: PositionGeometry; coords: ReadonlyArray<Coord>; precision: number;
  metrics: PositionMetrics; outcome: PositionOutcome; colors: PositionColors;
  /** Pixel x of a time / pixel y of a price. */
  xOf: (ts: number) => number; yOf: (v: number) => number;
  formatTime: (ts: number) => string; font: { family: string; size: number };
  /** Width of the pane: labels stay inside it. */
  paneWidth: number;
}

const zone = (x: number, w: number, y1: number, y2: number, color: string): OverlayFigure => ({
  type: 'rect', attrs: { x, y: Math.min(y1, y2), width: w, height: Math.abs(y2 - y1) }, styles: { style: 'fill', color },
});

const PAD_X = 4;
/** Estimated label width (no canvas measuring in the figure callback): average glyph ≈ 0.6 em, plus padding. */
const labelWidth = (text: string, size: number) => text.length * size * 0.6 + 2 * PAD_X;

/** `text` cut with an ellipsis so its estimated width fits `max`. */
function fitText(text: string, size: number, max: number): string {
  if (labelWidth(text, size) <= max) return text;
  const chars = Math.max(1, Math.floor((max - 2 * PAD_X) / (size * 0.6)));
  return `${text.slice(0, chars - 1)}…`;
}

/**
 * The figures of a position: zones, traversed shading (outcome, from the fill bar), entry line, labels. Labels are
 * centered on the visible part of the box and kept inside the pane; target / stop labels sit outside their edge;
 * the center and outcome labels move right of the box when it is narrower than them, and the outcome label moves
 * beyond the stop label when the stop zone is too short; labels wider than the pane are truncated.
 */
export function positionFigures(p: PositionFigureInput): OverlayFigure[] {
  const [e, t, s, end] = p.coords;
  if (!e || !t || !s || !end) return [];
  const left = Math.min(e.x, end.x);
  const right = Math.max(e.x, end.x);
  const w = right - left;
  const { up, down, neutral } = p.colors;
  const { metrics: m, outcome } = p;
  const figures: OverlayFigure[] = [
    zone(left, w, e.y, t.y, hexToRgba(up, ZONE_ALPHA)),
    zone(left, w, e.y, s.y, hexToRgba(down, ZONE_ALPHA)),
  ];
  const profit = hasResult(outcome) && (outcome.kind === 'target' || (outcome.kind !== 'stop' && outcome.pnlPct >= 0));
  if (hasResult(outcome)) {
    const clampX = (x: number) => Math.min(right, Math.max(left, x));
    const x0 = clampX(p.xOf(outcome.fillTs));
    const x1 = clampX(p.xOf(outcome.ts));
    const y = outcome.kind === 'target' ? t.y : outcome.kind === 'stop' ? s.y : p.yOf(outcome.price);
    if (x1 > x0) figures.push(zone(x0, x1 - x0, e.y, y, hexToRgba(profit ? up : down, TRAVERSED_ALPHA)));
  }
  figures.push({ type: 'line', attrs: { coordinates: [{ x: left, y: e.y }, { x: right, y: e.y }] }, styles: { color: neutral, size: 1, style: 'solid' } });

  const size = p.font.size;
  const paneW = Math.max(p.paneWidth, 1);
  // Center of the visible part of the box (the whole box when it is off screen).
  const visL = Math.max(left, 0);
  const visR = Math.min(right, paneW);
  const center = visR > visL ? (visL + visR) / 2 : (left + right) / 2;
  const visible = Math.max(0, visR - visL);
  type Placement = { y: number; baseline: 'top' | 'bottom' | 'middle'; outsideRight?: boolean };
  const label = (raw: string, at: Placement, bg: string): OverlayFigure => {
    const text = fitText(raw, size, paneW);
    const width = labelWidth(text, size);
    // Centerd on the visible box, kept fully on the pane; beside the box (right, else left) when asked and it fits.
    let x = Math.min(paneW - width / 2, Math.max(width / 2, center));
    let align: 'center' | 'left' | 'right' = 'center';
    if (at.outsideRight) {
      if (right >= 0 && right + PAD_X + width <= paneW) { x = right + PAD_X; align = 'left'; }
      else if (left <= paneW && left - PAD_X - width >= 0) { x = left - PAD_X; align = 'right'; }
    }
    return {
      type: 'text',
      ignoreEvent: true,
      attrs: { x, y: at.y, text, align, baseline: at.baseline },
      styles: {
        color: readableTextOn(bg), backgroundColor: bg, borderColor: bg, borderSize: 0, borderRadius: 2,
        family: p.font.family, size, paddingLeft: PAD_X, paddingRight: PAD_X, paddingTop: 2, paddingBottom: 2,
      },
    } as OverlayFigure;
  };
  const edge = (y: number): Placement => (y <= e.y ? { y: y - 2, baseline: 'bottom' } : { y: y + 2, baseline: 'top' });
  const stopEdge = edge(s.y);
  figures.push(label(targetLabel(p.g, m, p.precision), edge(t.y), up));
  figures.push(label(stopLabel(p.g, m, p.precision), stopEdge, down));
  const centerText = centerLabel(p.side, m);
  const narrow = (text: string) => labelWidth(text, size) > visible;
  figures.push(label(centerText, { y: e.y, baseline: 'middle', outsideRight: narrow(centerText) }, neutral));

  const text = outcomeLabel(outcome, p.formatTime);
  const bg = !hasResult(outcome) ? neutral : profit ? up : down;
  const offset = size + 8;
  const below = s.y >= e.y; // the outcome label goes to the stop side (the target label is on the other one)
  const roomInside = Math.abs(s.y - e.y) >= offset + size / 2 + 4;
  // Near the entry when the stop zone has room, else beyond the stop label (never over it); beside a narrow box.
  const at: Placement = roomInside
    ? { y: below ? e.y + offset : e.y - offset, baseline: 'middle' }
    : below ? { y: stopEdge.y + offset, baseline: 'top' } : { y: stopEdge.y - offset, baseline: 'bottom' };
  if (narrow(text)) at.outsideRight = true;
  figures.push(label(text, at, bg));
  return figures;
}

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];
type EventParams = Parameters<NonNullable<OverlayTemplate['performEventPressedMove']>>[0];

function template(name: 'longPosition' | 'shortPosition'): OverlayTemplate {
  const side = sideOf(name)!;
  return {
    name,
    totalStep: 2, // one click: the entry
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: (p: FigureParams) => {
      const g = fromPositionPoints(p.overlay.points);
      if (!g || p.coordinates.length < 4) return [];
      const yAxis = p.yAxis as { convertToPixel: (v: number) => number; convertFromPixel?: (px: number) => number } | null;
      if (yAxis?.convertFromPixel) {
        const gap = Math.abs(yAxis.convertFromPixel(0) - yAxis.convertFromPixel(HANDLE_GAP_PX));
        if (Number.isFinite(gap)) positionContext.minGapPrice = gap;
      }
      const font = p.chart.getStyles?.()?.overlay?.text;
      const xAxis = p.xAxis as { convertTimestampToPixel?: (ts: number) => number } | null;
      const state = positionState({
        id: p.overlay.id ?? name, side, g,
        bars: (p.chart.getDataList?.() ?? []) as OutcomeBar[], historyComplete: positionContext.historyComplete(), barMs: positionContext.barMs,
      });
      return positionFigures({
        side, g, coords: p.coordinates, metrics: state.metrics, outcome: state.outcome,
        precision: p.chart.getSymbol?.()?.pricePrecision ?? drawingConstraint.precision,
        colors: positionContext.colors,
        xOf: (ts) => xAxis?.convertTimestampToPixel?.(ts) ?? p.coordinates[0]!.x,
        yOf: (v) => yAxis?.convertToPixel(v) ?? p.coordinates[0]!.y,
        formatTime: positionContext.formatTime,
        font: { family: font?.family ?? 'Helvetica Neue', size: font?.size ?? 12 },
        paneWidth: p.bounding?.width ?? 0,
      });
    },
    // While placing: the default target / stop / end follow the entry under the cursor.
    performEventMoveForDrawing: ({ points, performPointIndex }: EventParams) => {
      const p0 = points[0];
      if (performPointIndex !== 0 || typeof p0?.timestamp !== 'number' || typeof p0.value !== 'number') return;
      const g = defaultGeometry(side, p0.timestamp, p0.value, positionContext.endFor(p0.timestamp), drawingConstraint.precision, positionContext.defaults);
      const [, t, s, end] = toPositionPoints(g);
      points[1] = t!;
      points[2] = s!;
      points[3] = end!;
    },
    performEventPressedMove: ({ points, performPointIndex }: EventParams) => {
      pressedMove(side, points, performPointIndex, drawingConstraint.precision, {
        minEnd: positionContext.minEnd, shiftEnd: positionContext.shiftEnd, minGap: positionContext.minGapPrice,
      });
    },
  };
}

let registered = false;

/** Registers the 'longPosition' / 'shortPosition' overlays (once; `force` re-registers, for tests). */
export function registerPositionOverlays(force = false): void {
  if (registered && !force) return;
  registered = true;
  registerOverlay(template('longPosition'));
  registerOverlay(template('shortPosition'));
}

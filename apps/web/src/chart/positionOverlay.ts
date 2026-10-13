import { DEFAULT_POSITION_SETTINGS, sanitizePositionSettings, type PositionDefaults } from '@altv/shared';
import { registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';
import { readableTextOn } from './contrast';
import { drawingConstraint, POSITION_STYLE_KEY } from './drawingTemplates';
import {
  centreLabel, DEFAULT_WIDTH_BARS, defaultGeometry, evaluateOutcome, fromPositionPoints, outcomeLabel, positionMetrics, pressedMove, sideOf,
  stopLabel, targetLabel, toPositionPoints, type OutcomeBar, type PositionGeometry, type PositionSide,
} from './position';
import { hexToRgba } from './theme';

export { POSITION_STYLE_KEY };

/** Fill opacity of the profit / loss zones, and of the part already traversed by the price (outcome). */
export const ZONE_ALPHA = 0.2;
export const TRAVERSED_ALPHA = 0.4;

export interface PositionColors { up: string; down: string; neutral: string }

/**
 * Shared rendering / placement state of the position overlays (one chart per page), set by the ChartAdapter:
 * bar duration of the timeframe, quantity decimals of the symbol, the global risk defaults, theme colours,
 * the default end time of a new position (≈ 20 bars after its start) and the bar-time format of outcome labels.
 */
export const positionContext: {
  barMs: number; qtyDecimals: number; defaults: PositionDefaults; colors: PositionColors;
  endFor: (start: number) => number; formatTime: (ts: number) => string;
} = {
  barMs: 86_400_000,
  qtyDecimals: 0,
  defaults: { ...DEFAULT_POSITION_SETTINGS },
  colors: { up: '#26a69a', down: '#ef5350', neutral: '#868b98' },
  endFor: (start) => start + DEFAULT_WIDTH_BARS * positionContext.barMs,
  formatTime: (ts) => new Date(ts).toISOString().slice(0, 10),
};

/** Effective risk settings of a position: its own (from its overlay styles) over the global defaults. */
export function positionSettingsOf(styles: unknown): PositionDefaults {
  const own = sanitizePositionSettings((styles as Record<string, unknown> | null | undefined)?.[POSITION_STYLE_KEY]);
  return { ...positionContext.defaults, ...own };
}

type Coord = { x: number; y: number };

export interface PositionFigureInput {
  side: PositionSide; g: PositionGeometry; coords: ReadonlyArray<Coord>; settings: PositionDefaults; precision: number; qtyDecimals: number;
  colors: PositionColors; bars: ReadonlyArray<OutcomeBar>;
  /** Pixel x of a time / pixel y of a price. */
  xOf: (ts: number) => number; yOf: (v: number) => number;
  formatTime: (ts: number) => string; font: { family: string; size: number };
}

const zone = (x: number, w: number, y1: number, y2: number, color: string): OverlayFigure => ({
  type: 'rect', attrs: { x, y: Math.min(y1, y2), width: w, height: Math.abs(y2 - y1) }, styles: { style: 'fill', color },
});

/** The figures of a position: zones, traversed shading (outcome), entry line, labels. */
export function positionFigures(p: PositionFigureInput): OverlayFigure[] {
  const [e, t, s, end] = p.coords;
  if (!e || !t || !s || !end) return [];
  const left = Math.min(e.x, end.x);
  const right = Math.max(e.x, end.x);
  const w = right - left;
  const { up, down, neutral } = p.colors;
  const figures: OverlayFigure[] = [
    zone(left, w, e.y, t.y, hexToRgba(up, ZONE_ALPHA)),
    zone(left, w, e.y, s.y, hexToRgba(down, ZONE_ALPHA)),
  ];
  const m = positionMetrics(p.side, p.g, p.settings, p.qtyDecimals);
  const outcome = evaluateOutcome(p.bars, p.side, p.g, m.qty);
  if (outcome.kind !== 'pending') {
    const x = Math.min(right, Math.max(left, p.xOf(outcome.ts)));
    const profit = outcome.kind === 'target' || (outcome.kind !== 'stop' && outcome.pnl >= 0);
    const y = outcome.kind === 'target' ? t.y : outcome.kind === 'stop' ? s.y : p.yOf(outcome.price);
    if (x > left) figures.push(zone(left, x - left, e.y, y, hexToRgba(profit ? up : down, TRAVERSED_ALPHA)));
  }
  figures.push({ type: 'line', attrs: { coordinates: [{ x: left, y: e.y }, { x: right, y: e.y }] }, styles: { color: neutral, size: 1, style: 'solid' } });

  const label = (text: string, y: number, baseline: 'top' | 'bottom' | 'middle', bg: string): OverlayFigure => ({
    type: 'text',
    ignoreEvent: true,
    attrs: { x: left + w / 2, y, text, align: 'center', baseline },
    styles: {
      color: readableTextOn(bg), backgroundColor: bg, borderColor: bg, borderSize: 0, borderRadius: 2,
      family: p.font.family, size: p.font.size, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2,
    },
  } as OverlayFigure);
  const edge = (y: number) => (y <= e.y ? { y: y - 2, baseline: 'bottom' as const } : { y: y + 2, baseline: 'top' as const });
  const te = edge(t.y);
  const se = edge(s.y);
  figures.push(label(targetLabel(p.g, m, p.precision, p.settings.currency), te.y, te.baseline, up));
  figures.push(label(stopLabel(p.g, m, p.precision, p.settings.currency), se.y, se.baseline, down));
  figures.push(label(centreLabel(p.side, m), e.y, 'middle', neutral));
  const text = outcomeLabel(outcome, p.settings.currency, p.formatTime);
  if (text !== null && outcome.kind !== 'pending') {
    const bg = outcome.kind === 'target' || (outcome.kind !== 'stop' && outcome.pnl >= 0) ? up : down;
    // Beside the centre label, on the stop side (the target label sits on the other side).
    const offset = p.font.size + 8;
    const below = s.y >= e.y;
    figures.push(label(text, below ? e.y + offset : e.y - offset, 'middle', bg));
  }
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
      const styles = p.chart.getStyles?.();
      const font = styles?.overlay?.text;
      const xAxis = p.xAxis as { convertTimestampToPixel?: (ts: number) => number } | null;
      return positionFigures({
        side, g, coords: p.coordinates, settings: positionSettingsOf(p.overlay.styles),
        precision: p.chart.getSymbol?.()?.pricePrecision ?? drawingConstraint.precision,
        qtyDecimals: positionContext.qtyDecimals, colors: positionContext.colors,
        bars: (p.chart.getDataList?.() ?? []) as OutcomeBar[],
        xOf: (ts) => xAxis?.convertTimestampToPixel?.(ts) ?? p.coordinates[0]!.x,
        yOf: (v) => p.yAxis?.convertToPixel(v) ?? p.coordinates[0]!.y,
        formatTime: positionContext.formatTime,
        font: { family: font?.family ?? 'Helvetica Neue', size: font?.size ?? 12 },
      });
    },
    // While placing: the default target / stop / end follow the entry under the cursor.
    performEventMoveForDrawing: ({ points, performPointIndex }: EventParams) => {
      const p0 = points[0];
      if (performPointIndex !== 0 || typeof p0?.timestamp !== 'number' || typeof p0.value !== 'number') return;
      const g = defaultGeometry(side, p0.timestamp, p0.value, positionContext.endFor(p0.timestamp), drawingConstraint.precision);
      const [, t, s, end] = toPositionPoints(g);
      points[1] = t!;
      points[2] = s!;
      points[3] = end!;
    },
    performEventPressedMove: ({ points, performPointIndex }: EventParams) => {
      pressedMove(side, points, performPointIndex, drawingConstraint.precision, positionContext.barMs);
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

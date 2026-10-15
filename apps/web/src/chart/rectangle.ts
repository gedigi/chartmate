import { registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';
import { parseColor, zoneTint } from './color';
import { drawingContext, fillOption } from './drawingTemplates';
import { THEME_TOKENS } from './theme';

/**
 * The rectangle drawing: a box anchored to two corners (time and price), with a crisp border and an optional tint.
 *
 * Points while on the chart (KLineChart draws a handle per point, so all eight handles are points):
 *   [0] corner A (first click)       [1] corner B (second click)      — the only two that are stored
 *   [2] corner (A's time, B's price) [3] corner (B's time, A's price)
 *   [4] midpoint of A's vertical edge   [5] midpoint of B's vertical edge
 *   [6] midpoint of A's horizontal edge [7] midpoint of B's horizontal edge
 * The midpoints carry a corner's time and price (so the axis labels of a selected rectangle show only its two
 * times and two prices); the template draws their handles exactly halfway along the edges. Dragging a corner moves
 * the two edges it touches, a midpoint only its edge (see resizeRectangle), the body moves the whole box.
 * Stored drawings hold [0] and [1] only (persistedPoints); two points given to KLineChart (restore, paste) are
 * expanded to the eight by the template.
 */
export const RECTANGLE = 'rectangle';

type Pt = { timestamp?: number; value?: number; dataIndex?: number };
type Corner = { timestamp: number; value: number };
type Coord = { x: number; y: number };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const cornerOf = (p: Pt | undefined): Corner | null => (p && num(p.timestamp) && num(p.value) ? { timestamp: p.timestamp, value: p.value } : null);

/** The eight points of a rectangle with corners `a` and `b` (see RECTANGLE). */
export function rectanglePoints(a: Corner, b: Corner): Corner[] {
  return [
    { ...a }, { ...b },
    { timestamp: a.timestamp, value: b.value }, { timestamp: b.timestamp, value: a.value },
    { ...a }, { ...b }, { ...a }, { ...b },
  ];
}

/**
 * Applies the move of handle `index` (already written into `points` by KLineChart) and rewrites all eight points
 * in place. Two complete points (a restore or a paste, KLineChart then reports the last index) are expanded.
 */
export function resizeRectangle(points: Pt[], index: number): void {
  const a = cornerOf(points[0]);
  const b = cornerOf(points[1]);
  if (!a || !b) return;
  if (points.length >= 8) {
    const p = points[index];
    const t = num(p?.timestamp) ? p.timestamp : undefined;
    const v = num(p?.value) ? p.value : undefined;
    switch (index) {
      case 2: if (t !== undefined) a.timestamp = t; if (v !== undefined) b.value = v; break;
      case 3: if (t !== undefined) b.timestamp = t; if (v !== undefined) a.value = v; break;
      case 4: if (t !== undefined) a.timestamp = t; break;
      case 5: if (t !== undefined) b.timestamp = t; break;
      case 6: if (v !== undefined) a.value = v; break;
      case 7: if (v !== undefined) b.value = v; break;
      default: break; // 0 / 1: the corner itself moved
    }
  }
  const next = rectanglePoints(a, b);
  points.length = 0;
  points.push(...next);
}

/** Points as stored: a rectangle keeps its two clicked corners; other drawings all their points. */
export function persistedPoints<T>(name: string, points: T[]): T[] {
  return name === RECTANGLE && points.length > 2 ? points.slice(0, 2) : points;
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** The box between two corner pixels, on whole pixels (the border then lands crisp on the pixel grid). */
export function rectangleBox(a: Coord, b: Coord): Box {
  return {
    left: Math.round(Math.min(a.x, b.x)), right: Math.round(Math.max(a.x, b.x)),
    top: Math.round(Math.min(a.y, b.y)), bottom: Math.round(Math.max(a.y, b.y)),
  };
}

/**
 * The border as four axis-aligned lines of width `size`. KLineChart shifts odd widths by half a pixel, so a
 * vertical edge at x covers [x + c − size/2, x + c + size/2) with c = 0.5 for odd widths: the horizontal edges span
 * from the left edge's outer side to the right edge's, so every corner is closed (dashes start at each corner).
 */
export function borderLines(box: Box, size: number): Array<{ coordinates: Coord[] }> {
  const c = size % 2 === 1 ? 0.5 : 0;
  const x0 = box.left + c - size / 2;
  const x1 = box.right + c + size / 2;
  return [
    { coordinates: [{ x: x0, y: box.top }, { x: x1, y: box.top }] },
    { coordinates: [{ x: x0, y: box.bottom }, { x: x1, y: box.bottom }] },
    { coordinates: [{ x: box.left, y: box.top }, { x: box.left, y: box.bottom }] },
    { coordinates: [{ x: box.right, y: box.top }, { x: box.right, y: box.bottom }] },
  ];
}

/** Pixel positions of the eight handles (see RECTANGLE): corners where they are, midpoints halfway along the box. */
export function handleCoordinates(a: Coord, b: Coord, box: Box): Coord[] {
  const midX = (box.left + box.right) / 2;
  const midY = (box.top + box.bottom) / 2;
  return [
    { ...a }, { ...b }, { x: a.x, y: b.y }, { x: b.x, y: a.y },
    { x: a.x, y: midY }, { x: b.x, y: midY }, { x: midX, y: a.y }, { x: midX, y: b.y },
  ];
}

/**
 * Fill weight of a rectangle (OKLab distance of the tint from the chart background, see color.ts zoneTint), per theme
 * like the channel fill: the dark ground needs more to read (also inside the extended-hours shade). A rectangle
 * marks a zone, so it reads a touch firmer than a channel band, and stays below ZONE_WEIGHT so position zones read
 * stronger; never above RECT_FILL_ALPHA, so the candles inside keep their colors.
 */
export const RECT_FILL_WEIGHT = { dark: 0.045, light: 0.032 } as const;
export const RECT_FILL_ALPHA = 0.14;

/** Fill of a rectangle bordered with `color`: its hue-locked tint on the chart background (accent when unreadable). */
export function rectangleFill(color: unknown): string {
  const accent = drawingContext.accent || THEME_TOKENS.dark.accent;
  const strong = typeof color === 'string' && parseColor(color) ? color : accent;
  return zoneTint(strong, drawingContext.bg || THEME_TOKENS.dark.bg, RECT_FILL_WEIGHT[drawingContext.theme], RECT_FILL_ALPHA);
}

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];
type EventParams = Parameters<NonNullable<OverlayTemplate['performEventPressedMove']>>[0];

function lineStyles(p: FigureParams): Record<string, unknown> {
  const own = (p.overlay.styles as { line?: Record<string, unknown> } | null | undefined)?.line ?? {};
  const base = (p.chart.getStyles?.().overlay?.line ?? {}) as unknown as Record<string, unknown>;
  return { ...base, ...own };
}

const template: OverlayTemplate = {
  name: RECTANGLE,
  totalStep: 3, // two clicks: opposite corners
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (p: FigureParams) => {
    const [a, b] = p.coordinates;
    if (!a || !b) return [];
    const box = rectangleBox(a, b);
    // KLineChart draws the handles after these figures from this same coordinates array (10.0.3): the midpoint
    // handles go halfway along the edges (if that ever changes they sit on the corners and still resize).
    if (p.coordinates.length >= 8) {
      const handles = handleCoordinates(a, b, box);
      for (let i = 4; i < 8; i++) Object.assign(p.coordinates[i]!, handles[i]);
    }
    const line = lineStyles(p);
    const size = typeof line.size === 'number' && line.size > 0 ? line.size : 1;
    const figures: OverlayFigure[] = [];
    // The tint first (under the border); clicking it selects / drags the rectangle, a right click inside is ignored.
    if (fillOption(RECTANGLE, p.overlay.styles) !== false) {
      figures.push({
        type: 'rect', ignoreEvent: ['onRightClick'],
        attrs: { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
        styles: { style: 'fill', color: rectangleFill(line.color), borderSize: 0 },
      } as OverlayFigure);
    }
    // Color, width and dash come from the drawing's line style (KLineChart merges it into line figures).
    figures.push({ type: 'line', attrs: borderLines(box, size) } as unknown as OverlayFigure);
    return figures;
  },
  // While placing the second corner, the other handles follow it.
  performEventMoveForDrawing: ({ points, performPointIndex }: EventParams) => {
    if (performPointIndex === 1) resizeRectangle(points, 1);
  },
  performEventPressedMove: ({ points, performPointIndex }: EventParams) => {
    resizeRectangle(points, performPointIndex);
  },
};

let registered = false;

/** Registers the 'rectangle' overlay (once; `force` re-registers, for tests). */
export function registerRectangleOverlay(force = false): void {
  if (registered && !force) return;
  registered = true;
  registerOverlay(template);
}

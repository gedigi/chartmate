import type { OverlayFigure, OverlayTemplate } from 'klinecharts';
import { readableTextOn } from './contrast';
import { drawingContext } from './drawingTemplates';
import { THEME_TOKENS } from './theme';

/**
 * The bell on a drawing that has an alert: a small round badge at the drawing's right end (its rightmost point, the
 * top one on a tie), filled with the drawing's color while the alert is on and hollow when it is off. Drawn as part of
 * the drawing (it follows a drag), but it takes no clicks. The adapter keeps `alertBadges` in step with the alerts of
 * the drawings on the chart (one chart per page, like the other drawing state here).
 */
export const alertBadges = new Map<string, { on: boolean }>();
/** Shown only where alerts are checked (the desktop app), like the bell button and the Alerts panel. */
export const alertBadgeSettings = { enabled: false };

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];
type Template = OverlayTemplate & Record<string, unknown>;
type Pt = { x: number; y: number };

const R = 8;
/** A bell in a 10 px box around the badge's center: the dome and its rim (closed), and the clapper. */
const DOME: ReadonlyArray<[number, number]> = [
  [-3.4, 2.2], [-3.4, -0.6], [-3, -2.6], [-1.8, -3.9], [0, -4.4], [1.8, -3.9], [3, -2.6], [3.4, -0.6], [3.4, 2.2],
  [4.5, 3.3], [-4.5, 3.3],
];

/** Drawings that reach the pane's right edge whatever their points: still on screen when their points are off its left. */
const EXTENDS_RIGHT = new Set(['horizontalStraightLine', 'horizontalRayLine', 'priceLine', 'rayLine', 'straightLine']);

/**
 * Where the badge goes: up and to the right of the drawing's rightmost point, kept inside the pane. None when that point
 * is off the pane's left edge (the drawing is scrolled out of view), unless the drawing reaches across to the right.
 */
export function badgeCenter(
  coordinates: ReadonlyArray<Partial<Pt>>, bounding: { width: number; height: number }, extendsRight = false,
): Pt | null {
  let best: Pt | null = null;
  for (const c of coordinates) {
    if (typeof c.x !== 'number' || typeof c.y !== 'number' || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    if (!best || c.x > best.x || (c.x === best.x && c.y < best.y)) best = { x: c.x, y: c.y };
  }
  if (!best || (best.x < 0 && !extendsRight)) return null;
  const x = Math.min(Math.max(best.x + R + 4, R + 2), bounding.width - R - 2);
  const y = Math.min(Math.max(best.y - R - 4, R + 2), bounding.height - R - 2);
  return { x, y };
}

/** The badge's figures for the drawing (none without an alert). */
export function alertBadgeFigures(p: FigureParams): OverlayFigure[] {
  const badge = alertBadgeSettings.enabled ? alertBadges.get(p.overlay.id) : undefined;
  if (!badge) return [];
  const at = badgeCenter(p.coordinates, p.bounding, EXTENDS_RIGHT.has(p.overlay.name));
  if (!at) return [];
  const own = (p.overlay.styles as { line?: { color?: unknown } } | null | undefined)?.line?.color;
  const base = (p.chart.getStyles?.().overlay?.line as { color?: unknown } | undefined)?.color;
  const color = typeof own === 'string' ? own : typeof base === 'string' ? base : THEME_TOKENS.dark.accent;
  const bg = drawingContext.bg || THEME_TOKENS.dark.bg;
  const glyph = badge.on ? readableTextOn(color) : color;
  return [
    {
      type: 'circle', ignoreEvent: true, attrs: { x: at.x, y: at.y, r: R },
      styles: badge.on
        ? { style: 'fill', color }
        : { style: 'stroke_fill', color: bg, borderColor: color, borderSize: 1.5 },
    },
    {
      type: 'polygon', ignoreEvent: true, attrs: { coordinates: DOME.map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy })) },
      styles: { style: 'fill', color: glyph },
    },
    { type: 'circle', ignoreEvent: true, attrs: { x: at.x, y: at.y + 4.6, r: 1.3 }, styles: { style: 'fill', color: glyph } },
  ] as unknown as OverlayFigure[];
}

/** The template with the bell added to its figures. */
export function withAlertBadge<T extends OverlayTemplate>(t: T): T {
  const create = t.createPointFigures;
  if (!create) return t;
  return {
    ...t,
    createPointFigures(this: unknown, p: FigureParams) {
      const own = create.call(this, p);
      const figures = own ? ([] as OverlayFigure[]).concat(own) : [];
      return [...figures, ...alertBadgeFigures(p)];
    },
  } as T & Template;
}

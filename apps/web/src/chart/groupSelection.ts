import type { OverlayFigure, OverlayTemplate } from 'klinecharts';
import { drawingContext } from './drawingTemplates';
import { THEME_TOKENS } from './theme';

/**
 * Several drawings selected at once (Shift-click adds a drawing to the selection, or takes it out). KLineChart selects
 * one drawing at a time and draws its handles; the others of the group get the same dots from here, drawn as part of
 * each drawing (they follow a drag) and taking no clicks. The adapter keeps this in step (one chart per page, like the
 * other drawing state here).
 */
export const groupSelection: {
  /** Every selected drawing while two or more are; empty otherwise. */
  ids: Set<string>;
  /** The drawing KLineChart itself has selected (it draws that one's handles). */
  clicked: string | null;
} = { ids: new Set(), clicked: null };

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];

/** KLineChart's own handle size (its point style: radius 5, 1 px border). */
const RADIUS = 5;

/** Handle dots on each point of a drawing of the group (none for the one KLineChart draws, or outside a group). */
export function groupMarkFigures(p: FigureParams): OverlayFigure[] {
  const id = p.overlay.id;
  if (groupSelection.ids.size < 2 || !groupSelection.ids.has(id) || id === groupSelection.clicked) return [];
  // In the drawing's color, like the handles KLineChart draws for the drawing it selected.
  const own = (p.overlay.styles as { line?: { color?: unknown } } | null | undefined)?.line?.color;
  const base = (p.chart?.getStyles?.().overlay?.line as { color?: unknown } | undefined)?.color;
  const color = typeof own === 'string' ? own : typeof base === 'string' ? base : drawingContext.accent || THEME_TOKENS.dark.accent;
  const bg = drawingContext.bg || THEME_TOKENS.dark.bg;
  return p.coordinates
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
    .map((c) => ({
      type: 'circle', ignoreEvent: true, attrs: { x: c.x, y: c.y, r: RADIUS },
      styles: { style: 'stroke_fill', color, borderColor: bg, borderSize: 1 },
    })) as unknown as OverlayFigure[];
}

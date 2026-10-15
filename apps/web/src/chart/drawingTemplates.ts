import type { LineStyleKind } from '@chartmate/shared';
import { getOverlayClass, registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';
import { parseColor, zoneTint } from './color';
import { readableTextOn } from './contrast';
import { THEME_TOKENS } from './theme';

/**
 * Wrapped KLineChart 10.0.3 built-in drawing templates (re-registered under the same names, once, before any
 * chart creates overlays), plus our own parallel channel:
 *  - Shift held: trend line / ray / extended line / parallel channel stay horizontal (0°) while placed or dragged;
 *  - parallel channel ('parallelChannel', the toolbar tool): two parallel segments spanning the first to the second
 *    point (the third sets the offset), a dashed midline and a translucent fill between them; "Extend left / right"
 *    (styles) extend all three to the pane edge. Legacy channels ('parallelStraightLine', KLineChart's infinite
 *    channel, saved before) are drawn by the same code with both sides extended by default and no fill, so they
 *    look as before;
 *  - price line / horizontal line: optional price text on the line and a persistent price label on the y-axis.
 */

/** `v` rounded to `decimals` decimals (clean binary value, e.g. 1.005 → 1.01, never 1.0049999). */
export function roundPrice(v: number, decimals: number): number {
  // Decimal shift via the exponent notation avoids binary artifacts (1.005 * 100 = 100.49999…).
  const shifted = Number(`${Math.round(Number(`${v}e${decimals}`))}e-${decimals}`);
  if (Number.isFinite(shifted)) return shifted;
  const f = 10 ** decimals; // v itself was in exponent notation
  return Number((Math.round(v * f) / f).toFixed(decimals));
}

/** The parallel channel the toolbar draws (finite unless extended). */
export const CHANNEL = 'parallelChannel';
/** KLineChart's parallel channel, drawn by older versions: kept for saved drawings (extended both ways by default). */
export const LEGACY_CHANNEL = 'parallelStraightLine';
/** Tools Shift constrains to horizontal. Base points (0 and 1) are constrained; a channel's width point is free. */
export const SHIFT_TOOLS: ReadonlySet<string> = new Set(['segment', 'rayLine', 'straightLine', CHANNEL, LEGACY_CHANNEL]);

/**
 * Shared constraint state (one chart per page). `shift`: Shift held (set by the toolbar via the adapter);
 * `precision`: the current symbol's price precision; `draggingId`: overlay being dragged (KLineChart also runs
 * performEventPressedMove when points are set programmatically, which must never be constrained).
 */
export const drawingConstraint: { shift: boolean; precision: number; draggingId: string | null } = {
  shift: false, precision: 2, draggingId: null,
};

type Pt = { timestamp?: number; value?: number; dataIndex?: number };

function setBase(points: Pt[], value: number | undefined, precision: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const v = roundPrice(value, precision);
  for (const i of [0, 1]) if (points[i]) points[i]!.value = v;
}

/** While placing point `index` of `name`: it (and the first point) take the first point's rounded price. */
export function constrainForDrawing(name: string, points: Pt[], index: number, precision: number): void {
  if (!SHIFT_TOOLS.has(name) || index !== 1) return; // the first point is the anchor; a channel's width point is free
  setBase(points, points[0]?.value, precision);
}

/** While dragging point `index`: the base points take the price of the opposite (fixed) base point. */
export function constrainPointMove(name: string, points: Pt[], index: number, precision: number): void {
  if (!SHIFT_TOOLS.has(name) || (index !== 0 && index !== 1)) return;
  setBase(points, points[1 - index]?.value, precision);
}

/** While dragging the whole drawing: the base points take the first point's price. */
export function flattenBase(name: string, points: Pt[], precision: number): void {
  if (!SHIFT_TOOLS.has(name)) return;
  setBase(points, points[0]?.value, precision);
}

type Coord = { x: number; y: number };

/** Midline of a channel: through the midpoints of the corresponding endpoints of its first two lines. */
export function channelMidline(lines: ReadonlyArray<{ coordinates: Coord[] }>): { coordinates: Coord[] } | null {
  const [a, b] = lines;
  if (!a || !b || a.coordinates.length !== b.coordinates.length) return null;
  return { coordinates: a.coordinates.map((c, i) => ({ x: (c.x + b.coordinates[i]!.x) / 2, y: (c.y + b.coordinates[i]!.y) / 2 })) };
}

type Line = { coordinates: Coord[] };
export interface ExtendOptions { left: boolean; right: boolean }

/**
 * Geometry of a parallel channel from its pixel coordinates (base points 0 and 1, offset point 2): the base line
 * spans the base points, left → right on screen; the parallel line is the base moved by the offset of point 2
 * (vertically, as KLineChart's channel: point 2 lies on it); the midline is halfway. `extend.left` / `extend.right`
 * extend all of them to the pane's left / right edge (for a vertical base: its top / bottom edge), never shortening
 * a base reaching past it. `fill` is the parallelogram between the two lines (null until the offset point exists).
 */
export function channelGeometry(
  coords: ReadonlyArray<Coord>, bounding: { width: number; height: number }, extend: ExtendOptions,
): { lines: Line[]; midline: Line | null; fill: Coord[] | null } {
  const [p0, p1, p2] = coords;
  if (!p0 || !p1) return { lines: [], midline: null, fill: null };
  let a: Coord;
  let b: Coord;
  let offset: Coord | null = null;
  if (p0.x === p1.x) {
    const [top, bottom] = p0.y <= p1.y ? [p0, p1] : [p1, p0];
    a = { x: p0.x, y: extend.left ? Math.min(0, top.y) : top.y };
    b = { x: p0.x, y: extend.right ? Math.max(bounding.height, bottom.y) : bottom.y };
    if (p2) offset = { x: p2.x - p0.x, y: 0 };
  } else {
    const k = (p1.y - p0.y) / (p1.x - p0.x);
    const [l, r] = p0.x < p1.x ? [p0, p1] : [p1, p0];
    const xl = extend.left ? Math.min(0, l.x) : l.x;
    const xr = extend.right ? Math.max(bounding.width, r.x) : r.x;
    a = { x: xl, y: l.y + k * (xl - l.x) };
    b = { x: xr, y: r.y + k * (xr - r.x) };
    if (p2) offset = { x: 0, y: p2.y - (p0.y + k * (p2.x - p0.x)) };
  }
  const base: Line = { coordinates: [a, b] };
  if (!offset) return { lines: [base], midline: null, fill: null };
  const d = offset;
  const parallel: Line = { coordinates: [{ x: a.x + d.x, y: a.y + d.y }, { x: b.x + d.x, y: b.y + d.y }] };
  return {
    lines: [base, parallel],
    midline: channelMidline([base, parallel]),
    fill: [a, b, parallel.coordinates[1]!, parallel.coordinates[0]!],
  };
}

/**
 * A channel's fill: the hue-locked tint of its line color on the chart background (color.ts zoneTint, like position
 * and measure zones), never above CHANNEL_FILL_ALPHA so the candles stay visible. The perceived weight is per theme:
 * the same OKLab distance reads much fainter on the dark ground (and must stay visible inside the extended-hours
 * shade) than on the light one. Both stay below ZONE_WEIGHT, so position zones read stronger.
 */
export const CHANNEL_FILL_WEIGHT = { dark: 0.045, light: 0.028 } as const;
export const CHANNEL_FILL_ALPHA = 0.14;

/**
 * Theme the drawing templates read at draw time: its name, the chart background (fills are tinted onto it) and the
 * accent (fallback of an unreadable line color). Set by the ChartAdapter on init and theme / appearance changes.
 */
// bg / accent empty until set: the dark theme's (THEME_TOKENS is not read at module load, theme.ts imports this module indirectly).
export const drawingContext: { theme: 'dark' | 'light'; bg: string; accent: string } = { theme: 'dark', bg: '', accent: '' };

/** Fill of a channel drawn with line color `color`. */
export function channelFill(color: unknown): string {
  const accent = drawingContext.accent || THEME_TOKENS.dark.accent;
  const strong = typeof color === 'string' && parseColor(color) ? color : accent;
  return zoneTint(strong, drawingContext.bg || THEME_TOKENS.dark.bg, CHANNEL_FILL_WEIGHT[drawingContext.theme], CHANNEL_FILL_ALPHA);
}

/** Dash pattern of a channel midline: always dashed, longer when the channel itself is dashed / dotted. */
export function midlineDash(channel: LineStyleKind, size: number): number[] {
  const f = Math.max(1, size / 2);
  return channel === 'solid' ? [6 * f, 4 * f] : [14 * f, 6 * f];
}

/** Line style kind of KLineChart overlay line styles (dotted mapping: see drawingStyles dashPattern). */
function kindOf(line: Record<string, unknown> | undefined): LineStyleKind {
  if (line?.style !== 'dashed') return 'solid';
  const d = line.dashedValue;
  const oneDot = Array.isArray(d) && d[0] === 1 && d[1] === 2 && line.size === 1;
  return line.lineCap === 'round' || oneDot ? 'dotted' : 'dashed';
}

/** Key of the price-label options inside an overlay's KLineChart styles (ignored by KLineChart itself). */
export const LABEL_STYLE_KEY = 'chartmateLabel';
export interface LabelOptions { onLine: boolean; onAxis: boolean }
/** Drawings with price-label toggles and their defaults. */
export const LABEL_DEFAULTS: Readonly<Record<string, LabelOptions>> = {
  priceLine: { onLine: true, onAxis: true },
  horizontalStraightLine: { onLine: false, onAxis: true },
};

/** Key of a channel's extend options inside its KLineChart styles (ignored by KLineChart itself). */
export const EXTEND_STYLE_KEY = 'chartmateExtend';
/** Channels and their default extend options: new channels are finite, legacy ones were always infinite. */
export const EXTEND_DEFAULTS: Readonly<Record<string, ExtendOptions>> = {
  [CHANNEL]: { left: false, right: false },
  [LEGACY_CHANNEL]: { left: true, right: true },
};

/** Key of a drawing's fill option inside its KLineChart styles (ignored by KLineChart itself). */
export const FILL_STYLE_KEY = 'chartmateFill';
/** Drawings with a fill toggle and their default (rectangles are filled unless turned off). */
export const FILL_DEFAULTS: Readonly<Record<string, boolean>> = { rectangle: true };

/** Effective fill option of a drawing (null when it has none): its own (from styles) over the default. */
export function fillOption(name: string, styles: unknown): boolean | null {
  const d = FILL_DEFAULTS[name];
  if (d === undefined) return null;
  const own = (styles as Record<string, unknown> | null | undefined)?.[FILL_STYLE_KEY];
  return typeof own === 'boolean' ? own : d;
}

/** Effective extend options of a drawing (null when it has none): its own (from styles) over the defaults. */
export function extendOptions(name: string, styles: unknown): ExtendOptions | null {
  const d = EXTEND_DEFAULTS[name];
  if (!d) return null;
  const own = (styles as Record<string, unknown> | null | undefined)?.[EXTEND_STYLE_KEY] as Partial<ExtendOptions> | undefined;
  return {
    left: typeof own?.left === 'boolean' ? own.left : d.left,
    right: typeof own?.right === 'boolean' ? own.right : d.right,
  };
}

/** Effective label options of a drawing (null when it has none): its own (from styles) over the defaults. */
export function labelOptions(name: string, styles: unknown): LabelOptions | null {
  const d = LABEL_DEFAULTS[name];
  if (!d) return null;
  const own = (styles as Record<string, unknown> | null | undefined)?.[LABEL_STYLE_KEY] as Partial<LabelOptions> | undefined;
  return {
    onLine: typeof own?.onLine === 'boolean' ? own.onLine : d.onLine,
    onAxis: typeof own?.onAxis === 'boolean' ? own.onAxis : d.onAxis,
  };
}

type FigureParams = Parameters<NonNullable<OverlayTemplate['createPointFigures']>>[0];
type Template = OverlayTemplate & Record<string, unknown>;

const TEMPLATE_KEYS = [
  'name', 'totalStep', 'drawingMode', 'lock', 'visible', 'zLevel', 'mode', 'modeSensitivity', 'needDefaultPointFigure',
  'needDefaultXAxisFigure', 'needDefaultYAxisFigure', 'createPointFigures', 'createXAxisFigures', 'createYAxisFigures',
  'performEventPressedMove', 'performEventMoveForDrawing', 'styles', 'extendData', '__chartmateWrapped', '__chartmateOriginal',
] as const;

/** The template a built-in overlay class was made from (its constructor merges the template into the instance). */
function builtinTemplate(name: string): Template | null {
  const Cls = getOverlayClass(name) as (new () => Record<string, unknown>) | null;
  if (!Cls) return null;
  const inst = new Cls();
  const t: Record<string, unknown> = {};
  for (const key of TEMPLATE_KEYS) if (inst[key] !== undefined && inst[key] !== null) t[key] = inst[key];
  t.name = name;
  return t as Template;
}

const asArray = (f: OverlayFigure | OverlayFigure[] | undefined | null): OverlayFigure[] => (f ? ([] as OverlayFigure[]).concat(f) : []);

function lineStyles(p: FigureParams): Record<string, unknown> {
  const own = (p.overlay.styles as { line?: Record<string, unknown> } | null | undefined)?.line ?? {};
  const base = (p.chart.getStyles?.().overlay?.line ?? {}) as unknown as Record<string, unknown>;
  return { ...base, ...own };
}

function priceText(p: FigureParams): string | null {
  const value = p.overlay.points[0]?.value;
  if (typeof value !== 'number') return null;
  const text = value.toFixed(p.chart.getSymbol()?.pricePrecision ?? 2);
  // Same formatting as KLineChart's own price texts (thousands separator, decimal folding) when available.
  const thousands = p.chart.getThousandsSeparator?.()?.format(text) ?? text;
  return p.chart.getDecimalFold?.()?.format(thousands) ?? thousands;
}

/** Shift constraint around the template's own point handlers (`this` is the overlay instance). */
function withShift(t: Template): Template {
  const name = t.name;
  const drawing = t.performEventMoveForDrawing;
  const pressed = t.performEventPressedMove;
  type Params = Parameters<NonNullable<OverlayTemplate['performEventMoveForDrawing']>>[0];
  return {
    ...t,
    performEventMoveForDrawing(this: unknown, params: Params) {
      drawing?.call(this, params);
      if (drawingConstraint.shift) constrainForDrawing(name, params.points, params.performPointIndex, drawingConstraint.precision);
    },
    performEventPressedMove(this: { id?: string } | undefined, params: Params) {
      pressed?.call(this, params);
      if (drawingConstraint.shift && this?.id !== undefined && this.id === drawingConstraint.draggingId) {
        constrainPointMove(name, params.points, params.performPointIndex, drawingConstraint.precision);
      }
    },
  } as Template;
}

/**
 * A parallel channel: finite / extended lines, a dashed midline and (when `fill`) a translucent fill between the
 * lines (see channelGeometry). Legacy channels have no fill: they render exactly as KLineChart drew them.
 */
function withChannel(t: Template, fill: boolean): Template {
  const name = t.name;
  return {
    ...t,
    createPointFigures(p: FigureParams) {
      const extend = extendOptions(name, p.overlay.styles)!;
      const g = channelGeometry(p.coordinates, p.bounding, extend);
      if (g.lines.length === 0) return [];
      const line = lineStyles(p);
      const figures: OverlayFigure[] = [];
      // The fill first (under the lines); it is part of the drawing, so clicking inside it selects / drags the
      // channel, but a right click inside it is ignored (KLineChart's right click removes).
      if (fill && g.fill) {
        figures.push({
          type: 'polygon', attrs: { coordinates: g.fill }, ignoreEvent: ['onRightClick'],
          styles: { style: 'fill', color: channelFill(line.color), borderSize: 0 },
        } as OverlayFigure);
      }
      figures.push({ type: 'line', attrs: g.lines } as unknown as OverlayFigure);
      if (g.midline) {
        const size = typeof line.size === 'number' ? line.size : 1;
        // Color and width are inherited from the channel's line style (KLineChart merges figure styles over it).
        figures.push({ type: 'line', attrs: g.midline, styles: { style: 'dashed', dashedValue: midlineDash(kindOf(line), size), lineCap: 'butt' } } as OverlayFigure);
      }
      return figures;
    },
  } as Template;
}

function withLabels(t: Template): Template {
  const name = t.name;
  const create = t.createPointFigures!;
  return {
    ...t,
    needDefaultYAxisFigure: false, // replaced by the persistent label below (KLineChart's shows only when selected)
    createPointFigures(p: FigureParams) {
      const opts = labelOptions(name, p.overlay.styles)!;
      const own = asArray(create(p));
      const figures = opts.onLine ? own : own.filter((f) => f.type !== 'text');
      const hasText = figures.some((f) => f.type === 'text');
      const c = p.coordinates[0];
      const text = priceText(p);
      if (opts.onLine && !hasText && c && text !== null) {
        figures.push({ type: 'text', ignoreEvent: true, attrs: { x: c.x, y: c.y, text, baseline: 'bottom' } } as OverlayFigure);
      }
      // The price bubble takes the line's own color (the overlay's text styles are the default drawing color's), with
      // white or dark glyphs, whichever reads on it.
      const color = String(lineStyles(p).color ?? THEME_TOKENS.dark.accent);
      return figures.map((f) => (f.type === 'text'
        ? { ...f, styles: { ...(f.styles as object | undefined), color: readableTextOn(color), backgroundColor: color, borderColor: color } } as OverlayFigure
        : f));
    },
    createYAxisFigures(p: FigureParams) {
      const opts = labelOptions(name, p.overlay.styles)!;
      const c = p.coordinates[0];
      const text = priceText(p);
      if (!opts.onAxis || !c || text === null) return [];
      const fromZero = (p.yAxis as { isFromZero?: () => boolean } | null)?.isFromZero?.() ?? false;
      const color = String(lineStyles(p).color ?? THEME_TOKENS.dark.accent);
      return [{
        type: 'text',
        ignoreEvent: true,
        attrs: { x: fromZero ? 0 : p.bounding.width, y: c.y, text, align: fromZero ? 'left' : 'right', baseline: 'middle' },
        styles: {
          // White or dark, whichever reads on the line color (a white / ink drawing color included).
          color: readableTextOn(color), backgroundColor: color, borderColor: color, borderSize: 1, borderRadius: 2,
          paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2,
        },
      } as OverlayFigure];
    },
  } as Template;
}

/** Marks a template wrapped by us; ORIGINAL_KEY holds the KLineChart template it wraps. */
export const WRAPPED_MARK = '__chartmateWrapped';
const ORIGINAL_KEY = '__chartmateOriginal';

let registered = false;

/**
 * Re-registers the wrapped built-in drawing templates (once per module; a no-op when KLineChart lacks a
 * template). Idempotent across module instances too (HMR): an already wrapped class is unwrapped to its
 * original template first, so wrappers never stack (e.g. two channel midlines) and use this module's state.
 */
export function registerDrawingTemplates(): void {
  if (registered) return;
  registered = true;
  const original = (name: string): Template | null => {
    const t = builtinTemplate(name);
    return t && t[WRAPPED_MARK] === true && t[ORIGINAL_KEY] ? (t[ORIGINAL_KEY] as Template) : t;
  };
  const register = (base: Template, f: (t: Template) => Template) => {
    registerOverlay({ ...f(base), [WRAPPED_MARK]: true, [ORIGINAL_KEY]: base } as Template);
  };
  const wrap = (name: string, f: (t: Template) => Template) => {
    const base = original(name);
    if (base) register(base, f);
  };
  wrap('segment', withShift);
  wrap('rayLine', withShift);
  wrap('straightLine', withShift);
  // Both channels are made from KLineChart's (unwrapped) parallel channel: same steps and point handling.
  const channel = original(LEGACY_CHANNEL);
  if (channel) {
    register(channel, (t) => withChannel(withShift(t), false));
    register(channel, (t) => withChannel(withShift({ ...t, name: CHANNEL }), true));
  }
  wrap('priceLine', withLabels);
  wrap('horizontalStraightLine', withLabels);
}

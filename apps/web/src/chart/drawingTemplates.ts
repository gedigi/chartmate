import type { LineStyleKind } from '@altv/shared';
import { getOverlayClass, registerOverlay, type OverlayFigure, type OverlayTemplate } from 'klinecharts';

/**
 * Wrapped KLineChart 10.0.3 built-in drawing templates (re-registered under the same names, once, before any
 * chart creates overlays):
 *  - Shift held: trend line / ray / extended line / parallel channel stay horizontal (0°) while placed or dragged;
 *  - parallel channel: a dashed midline halfway between the two lines (visual only, no stored point);
 *  - price line / horizontal line: optional price text on the line and a persistent price label on the y-axis.
 */

/** `v` rounded to `decimals` decimals (clean binary value, e.g. 1.005 → 1.01, never 1.0049999). */
export function roundPrice(v: number, decimals: number): number {
  // Decimal shift via the exponent notation avoids binary artefacts (1.005 * 100 = 100.49999…).
  const shifted = Number(`${Math.round(Number(`${v}e${decimals}`))}e-${decimals}`);
  if (Number.isFinite(shifted)) return shifted;
  const f = 10 ** decimals; // v itself was in exponent notation
  return Number((Math.round(v * f) / f).toFixed(decimals));
}

/** Tools Shift constrains to horizontal. Base points (0 and 1) are constrained; a channel's width point is free. */
export const SHIFT_TOOLS: ReadonlySet<string> = new Set(['segment', 'rayLine', 'straightLine', 'parallelStraightLine']);
const CHANNEL = 'parallelStraightLine';

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
export const LABEL_STYLE_KEY = 'altvLabel';
/** Key of a long / short position's own risk settings inside its KLineChart overlay styles (ignored by KLineChart). */
export const POSITION_STYLE_KEY = 'altvPosition';
export interface LabelOptions { onLine: boolean; onAxis: boolean }
/** Drawings with price-label toggles and their defaults. */
export const LABEL_DEFAULTS: Readonly<Record<string, LabelOptions>> = {
  priceLine: { onLine: true, onAxis: true },
  horizontalStraightLine: { onLine: false, onAxis: true },
};

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
  'performEventPressedMove', 'performEventMoveForDrawing', 'styles', 'extendData', '__altvWrapped', '__altvOriginal',
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

function withMidline(t: Template): Template {
  const create = t.createPointFigures!;
  return {
    ...t,
    createPointFigures(p: FigureParams) {
      const figures = asArray(create(p));
      const lines = figures[0]?.attrs as unknown as Array<{ coordinates: Coord[] }> | undefined;
      const mid = Array.isArray(lines) ? channelMidline(lines) : null;
      if (!mid) return figures;
      const line = lineStyles(p);
      const size = typeof line.size === 'number' ? line.size : 1;
      // Colour and width are inherited from the channel's line style (KLineChart merges figure styles over it).
      return [...figures, { type: 'line', attrs: mid, styles: { style: 'dashed', dashedValue: midlineDash(kindOf(line), size), lineCap: 'butt' } } as OverlayFigure];
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
      return figures;
    },
    createYAxisFigures(p: FigureParams) {
      const opts = labelOptions(name, p.overlay.styles)!;
      const c = p.coordinates[0];
      const text = priceText(p);
      if (!opts.onAxis || !c || text === null) return [];
      const fromZero = (p.yAxis as { isFromZero?: () => boolean } | null)?.isFromZero?.() ?? false;
      const color = String(lineStyles(p).color ?? '#2962ff');
      return [{
        type: 'text',
        ignoreEvent: true,
        attrs: { x: fromZero ? 0 : p.bounding.width, y: c.y, text, align: fromZero ? 'left' : 'right', baseline: 'middle' },
        styles: {
          color: '#ffffff', backgroundColor: color, borderColor: color, borderSize: 1, borderRadius: 2,
          paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2,
        },
      } as OverlayFigure];
    },
  } as Template;
}

/** Marks a template wrapped by us; ORIGINAL_KEY holds the KLineChart template it wraps. */
export const WRAPPED_MARK = '__altvWrapped';
const ORIGINAL_KEY = '__altvOriginal';

let registered = false;

/**
 * Re-registers the wrapped built-in drawing templates (once per module; a no-op when KLineChart lacks a
 * template). Idempotent across module instances too (HMR): an already wrapped class is unwrapped to its
 * original template first, so wrappers never stack (e.g. two channel midlines) and use this module's state.
 */
export function registerDrawingTemplates(): void {
  if (registered) return;
  registered = true;
  const wrap = (name: string, f: (t: Template) => Template) => {
    const t = builtinTemplate(name);
    if (!t) return;
    const base = t[WRAPPED_MARK] === true && t[ORIGINAL_KEY] ? (t[ORIGINAL_KEY] as Template) : t;
    registerOverlay({ ...f(base), [WRAPPED_MARK]: true, [ORIGINAL_KEY]: base } as Template);
  };
  wrap('segment', withShift);
  wrap('rayLine', withShift);
  wrap('straightLine', withShift);
  wrap(CHANNEL, (t) => withMidline(withShift(t)));
  wrap('priceLine', withLabels);
  wrap('horizontalStraightLine', withLabels);
}

import {
  isHexColor, isPositionTool, MAX_LINE_WIDTH, MAX_TEXT_SIZE, MIN_LINE_WIDTH, MIN_TEXT_SIZE,
  sanitizePositionSettings, type DrawingLineStyle, type DrawingStyles, type LineStyleKind,
} from '@chartmate/shared';
import type { DeepPartial, OverlayStyle } from 'klinecharts';
import { readableTextOn } from './contrast';
import { EXTEND_DEFAULTS, EXTEND_STYLE_KEY, LABEL_DEFAULTS, LABEL_STYLE_KEY, POSITION_STYLE_KEY } from './drawingTemplates';

export type LabelStyle = NonNullable<DrawingStyles['label']>;
export type ExtendStyle = NonNullable<DrawingStyles['extend']>;

/** Dash pattern of dashed drawings (KLineChart's [2, 2] is barely visible). */
export const DRAWING_DASH = [6, 4];
export const TEXT_TOOL = 'simpleAnnotation';

export type TextStyle = NonNullable<DrawingStyles['text']>;

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Line styles in the order the style selects list them. */
export const LINE_STYLES: ReadonlyArray<{ value: LineStyleKind; label: string }> = [
  { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' },
];

/** A select value → line style (unknown → solid). */
export function parseLineStyle(v: string): LineStyleKind {
  return v === 'dashed' || v === 'dotted' ? v : 'solid';
}

/**
 * KLineChart only knows solid / dashed: dotted is a dashed line of dots. From 2px they are zero-length dashes
 * with round caps (a dot of the line's width) spaced by twice the width; at 1px a round cap only paints a
 * half-alpha speck, so 1px dots are square 1px dashes every 3px (butt caps).
 */
export function dashPattern(style: LineStyleKind, size: number, dashed: number[] = DRAWING_DASH): number[] {
  if (style !== 'dotted') return dashed;
  return size <= 1 ? [1, 2] : [0, size * 2];
}

/** True when KLineChart line styles are our dotted mapping (see dashPattern / klineLine). */
export function isDottedLine(l: Record<string, unknown> | undefined): boolean {
  if (l?.style !== 'dashed') return false;
  if (l.lineCap === 'round') return true;
  const d = l.dashedValue;
  return Array.isArray(d) && d.length === 2 && d[0] === 1 && d[1] === 2 && l.size === 1;
}

/**
 * KLineChart line styles for a line style kind. `lineCap` is not in KLineChart's typings but its line figure
 * honors it; it is always set because KLineChart merges overridden styles (dotted → solid must reset it).
 */
export function klineLine(style: LineStyleKind, size: number, dashed: number[] = DRAWING_DASH): { style: 'solid' | 'dashed'; dashedValue: number[]; lineCap: 'round' | 'butt' } {
  return {
    style: style === 'solid' ? 'solid' : 'dashed',
    dashedValue: dashPattern(style, size, dashed),
    lineCap: style === 'dotted' && size > 1 ? 'round' : 'butt',
  };
}

export function lineToOverlay(l: DrawingLineStyle): DeepPartial<OverlayStyle> {
  return { line: { color: l.color, size: l.size, ...klineLine(l.style, l.size) } as DeepPartial<OverlayStyle['line']> };
}

/** A text annotation's color is its bubble (background, border, pointer); the glyphs are white or dark, whichever reads on it. */
export function textToOverlay(t: TextStyle): DeepPartial<OverlayStyle> {
  return {
    text: { size: t.size, color: readableTextOn(t.color), backgroundColor: t.color, borderColor: t.color },
    line: { color: t.color },
    polygon: { color: t.color, borderColor: t.color },
  };
}

export function toOverlayStyles(s: DrawingStyles | undefined): DeepPartial<OverlayStyle> | undefined {
  let out: Record<string, unknown> | undefined = s?.text ? textToOverlay(s.text) : s?.line ? lineToOverlay(s.line) : undefined;
  // Price-label options, channel extend options and position risk settings ride along in the overlay styles
  // (KLineChart ignores the keys; our templates read them).
  if (s?.label) out = { ...out, [LABEL_STYLE_KEY]: { ...s.label } };
  if (s?.extend) out = { ...out, [EXTEND_STYLE_KEY]: { ...s.extend } };
  if (s?.position) out = { ...out, [POSITION_STYLE_KEY]: { ...s.position } };
  return out as DeepPartial<OverlayStyle> | undefined;
}

/** The valid label options in `l` (booleans only), or undefined. */
function readLabel(l: unknown): LabelStyle | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const out: LabelStyle = {};
  const { onLine, onAxis } = l as Record<string, unknown>;
  if (typeof onLine === 'boolean') out.onLine = onLine;
  if (typeof onAxis === 'boolean') out.onAxis = onAxis;
  return out.onLine !== undefined || out.onAxis !== undefined ? out : undefined;
}

/** The valid extend options in `e` (booleans only), or undefined. */
function readExtend(e: unknown): ExtendStyle | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const out: ExtendStyle = {};
  const { left, right } = e as Record<string, unknown>;
  if (typeof left === 'boolean') out.left = left;
  if (typeof right === 'boolean') out.right = right;
  return out.left !== undefined || out.right !== undefined ? out : undefined;
}

/** Reads the normalized line style out of KLineChart overlay styles (null when absent/invalid). */
export function readLine(styles: unknown): DrawingLineStyle | null {
  const l = (styles as { line?: Record<string, unknown> } | null | undefined)?.line;
  if (!l || !isHexColor(l.color) || !intIn(l.size, MIN_LINE_WIDTH, MAX_LINE_WIDTH)) return null;
  if (l.style !== 'solid' && l.style !== 'dashed' && l.style !== 'dotted') return null;
  // Normalized ('dotted') or KLineChart form (dotted = dashed with a dot pattern, see klineLine).
  const style: LineStyleKind = isDottedLine(l) ? 'dotted' : l.style;
  return { color: l.color.toLowerCase(), size: l.size, style };
}

export function readText(styles: unknown): TextStyle | null {
  const t = (styles as { text?: Record<string, unknown> } | null | undefined)?.text;
  if (!t || !isHexColor(t.backgroundColor) || !intIn(t.size, MIN_TEXT_SIZE, MAX_TEXT_SIZE)) return null;
  return { color: t.backgroundColor.toLowerCase(), size: t.size };
}

/** Normalized styles of an overlay (only what the app lets the user change), or undefined. */
export function normalizeOverlayStyles(name: string, styles: unknown): DrawingStyles | undefined {
  if (isPositionTool(name)) {
    // Positions have no line style: only their own risk settings.
    const position = sanitizePositionSettings((styles as Record<string, unknown> | null | undefined)?.[POSITION_STYLE_KEY]);
    return position ? { position } : undefined;
  }
  if (name === TEXT_TOOL) {
    const text = readText(styles);
    return text ? { text } : undefined;
  }
  const out: DrawingStyles = {};
  const line = readLine(styles);
  if (line) out.line = line;
  // Label options: only those that differ from the drawing's defaults are kept.
  const defaults = LABEL_DEFAULTS[name];
  const own = readLabel((styles as Record<string, unknown> | null | undefined)?.[LABEL_STYLE_KEY]);
  if (defaults && own) {
    const label: LabelStyle = {};
    if (own.onLine !== undefined && own.onLine !== defaults.onLine) label.onLine = own.onLine;
    if (own.onAxis !== undefined && own.onAxis !== defaults.onAxis) label.onAxis = own.onAxis;
    if (label.onLine !== undefined || label.onAxis !== undefined) out.label = label;
  }
  // Channel extend options: likewise only the sides that differ from the channel's defaults.
  const extendDefaults = EXTEND_DEFAULTS[name];
  const ownExtend = readExtend((styles as Record<string, unknown> | null | undefined)?.[EXTEND_STYLE_KEY]);
  if (extendDefaults && ownExtend) {
    const extend: ExtendStyle = {};
    if (ownExtend.left !== undefined && ownExtend.left !== extendDefaults.left) extend.left = ownExtend.left;
    if (ownExtend.right !== undefined && ownExtend.right !== extendDefaults.right) extend.right = ownExtend.right;
    if (extend.left !== undefined || extend.right !== undefined) out.extend = extend;
  }
  return out.line || out.label || out.extend ? out : undefined;
}

/** '#RRGGBB' / '#rgb' → '#rrggbb'; anything else → fallback. */
export function toHex(c: unknown, fallback: string): string {
  if (isHexColor(c)) return c.toLowerCase();
  if (typeof c === 'string' && /^#[0-9a-fA-F]{3}$/.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toLowerCase();
  return fallback;
}

/** The normalized styles in `s` that are valid (unknown keys, legacy and invalid values are dropped). */
export function sanitizeDrawingStyles(s: unknown): DrawingStyles | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: DrawingStyles = {};
  const line = readLine(s);
  if (line) out.line = line;
  const t = (s as { text?: Record<string, unknown> }).text;
  if (t && isHexColor(t.color) && intIn(t.size, MIN_TEXT_SIZE, MAX_TEXT_SIZE)) out.text = { color: t.color.toLowerCase(), size: t.size };
  const label = readLabel((s as { label?: unknown }).label);
  if (label) out.label = label;
  const extend = readExtend((s as { extend?: unknown }).extend);
  if (extend) out.extend = extend;
  const position = sanitizePositionSettings((s as { position?: unknown }).position);
  if (position) out.position = position;
  return out.line || out.text || out.label || out.extend || out.position ? out : undefined;
}

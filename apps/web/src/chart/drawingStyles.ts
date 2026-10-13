import {
  isHexColor, MAX_LINE_WIDTH, MAX_TEXT_SIZE, MIN_LINE_WIDTH, MIN_TEXT_SIZE,
  type DrawingLineStyle, type DrawingStyles, type LineStyleKind,
} from '@altv/shared';
import type { DeepPartial, OverlayStyle } from 'klinecharts';

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
 * KLineChart only knows solid / dashed: dotted is a dashed line of zero-length dashes with round caps (each
 * dash renders as a dot of the line's width), spaced by twice the width so it scales with it.
 */
export function dashPattern(style: LineStyleKind, size: number, dashed: number[] = DRAWING_DASH): number[] {
  return style === 'dotted' ? [0, size * 2] : dashed;
}

/**
 * KLineChart line styles for a line style kind. `lineCap` is not in KLineChart's typings but its line figure
 * honours it; it is always set because KLineChart merges overridden styles (dotted → solid must reset it).
 */
export function klineLine(style: LineStyleKind, size: number, dashed: number[] = DRAWING_DASH): { style: 'solid' | 'dashed'; dashedValue: number[]; lineCap: 'round' | 'butt' } {
  return {
    style: style === 'solid' ? 'solid' : 'dashed',
    dashedValue: dashPattern(style, size, dashed),
    lineCap: style === 'dotted' ? 'round' : 'butt',
  };
}

export function lineToOverlay(l: DrawingLineStyle): DeepPartial<OverlayStyle> {
  return { line: { color: l.color, size: l.size, ...klineLine(l.style, l.size) } as DeepPartial<OverlayStyle['line']> };
}

/** A text annotation's colour is its bubble (background, border, pointer); the glyphs stay white. */
export function textToOverlay(t: TextStyle): DeepPartial<OverlayStyle> {
  return {
    text: { size: t.size, backgroundColor: t.color, borderColor: t.color },
    line: { color: t.color },
    polygon: { color: t.color, borderColor: t.color },
  };
}

export function toOverlayStyles(s: DrawingStyles | undefined): DeepPartial<OverlayStyle> | undefined {
  if (s?.text) return textToOverlay(s.text);
  if (s?.line) return lineToOverlay(s.line);
  return undefined;
}

/** Reads the normalized line style out of KLineChart overlay styles (null when absent/invalid). */
export function readLine(styles: unknown): DrawingLineStyle | null {
  const l = (styles as { line?: Record<string, unknown> } | null | undefined)?.line;
  if (!l || !isHexColor(l.color) || !intIn(l.size, MIN_LINE_WIDTH, MAX_LINE_WIDTH)) return null;
  if (l.style !== 'solid' && l.style !== 'dashed' && l.style !== 'dotted') return null;
  // Normalized ('dotted') or KLineChart form (dotted = dashed with round caps, see klineLine).
  const style: LineStyleKind = l.style === 'dashed' && l.lineCap === 'round' ? 'dotted' : l.style;
  return { color: l.color.toLowerCase(), size: l.size, style };
}

export function readText(styles: unknown): TextStyle | null {
  const t = (styles as { text?: Record<string, unknown> } | null | undefined)?.text;
  if (!t || !isHexColor(t.backgroundColor) || !intIn(t.size, MIN_TEXT_SIZE, MAX_TEXT_SIZE)) return null;
  return { color: t.backgroundColor.toLowerCase(), size: t.size };
}

/** Normalized styles of an overlay (only what the app lets the user change), or undefined. */
export function normalizeOverlayStyles(name: string, styles: unknown): DrawingStyles | undefined {
  if (name === TEXT_TOOL) {
    const text = readText(styles);
    return text ? { text } : undefined;
  }
  const line = readLine(styles);
  return line ? { line } : undefined;
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
  return out.line || out.text ? out : undefined;
}

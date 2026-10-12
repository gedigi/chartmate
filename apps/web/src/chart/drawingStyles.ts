import {
  isHexColor, MAX_LINE_WIDTH, MAX_TEXT_SIZE, MIN_LINE_WIDTH, MIN_TEXT_SIZE,
  type DrawingLineStyle, type DrawingStyles,
} from '@altv/shared';
import type { DeepPartial, OverlayStyle } from 'klinecharts';

/** Dash pattern of dashed drawings (KLineChart's [2, 2] is barely visible). */
export const DRAWING_DASH = [6, 4];
export const TEXT_TOOL = 'simpleAnnotation';

export type TextStyle = NonNullable<DrawingStyles['text']>;

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function lineToOverlay(l: DrawingLineStyle): DeepPartial<OverlayStyle> {
  return { line: { color: l.color, size: l.size, style: l.style, dashedValue: DRAWING_DASH } };
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
  if (l.style !== 'solid' && l.style !== 'dashed') return null;
  return { color: l.color.toLowerCase(), size: l.size, style: l.style };
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

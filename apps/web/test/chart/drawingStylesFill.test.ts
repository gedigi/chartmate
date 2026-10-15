import { describe, expect, it } from 'vitest';
import { normalizeOverlayStyles, sanitizeDrawingStyles, toOverlayStyles } from '../../src/chart/drawingStyles';
import { resolveDrawingColor } from '../../src/chart/drawingColors';
import { THEME_TOKENS } from '../../src/chart/theme';

describe('rectangle fill option in drawing styles', () => {
  it('sanitize keeps a boolean fill only (alone or with a line / color)', () => {
    expect(sanitizeDrawingStyles({ fill: false })).toEqual({ fill: false });
    expect(sanitizeDrawingStyles({ fill: 'no' })).toBeUndefined();
    expect(sanitizeDrawingStyles({ color: 'palette:2', fill: false })).toEqual({ color: 'palette:2', fill: false });
    expect(sanitizeDrawingStyles({ line: { color: 'up', size: 2, style: 'dotted' }, fill: true }))
      .toEqual({ line: { color: 'up', size: 2, style: 'dotted' }, fill: true });
  });

  it('round trip: stored → overlay styles → stored; the default (filled) is not stored', () => {
    const stored = { line: { color: 'palette:1', size: 2, style: 'dashed' as const }, fill: false };
    const resolve = (c: string) => resolveDrawingColor(c, 'dark', undefined);
    const overlay = toOverlayStyles(sanitizeDrawingStyles(stored), resolve) as Record<string, any>;
    expect(overlay.chartmateFill).toBe(false);
    expect(overlay.chartmateColor).toBe('palette:1'); // the palette reference rides along; the drawn color is the theme's
    expect(overlay.line.color).toBe(resolve('palette:1'));
    expect(normalizeOverlayStyles('rectangle', overlay)).toEqual(stored);
    expect(normalizeOverlayStyles('rectangle', { chartmateFill: true })).toBeUndefined();
    // A color of its own (sticky default color) and fill off.
    expect(normalizeOverlayStyles('rectangle', toOverlayStyles({ color: 'down', fill: false }, resolve)))
      .toEqual({ color: 'down', fill: false });
    // Other drawings never carry a fill option.
    expect(normalizeOverlayStyles('segment', { chartmateFill: false })).toBeUndefined();
  });

  it('palette references resolve per theme (the border, and through it the fill tint)', () => {
    expect(resolveDrawingColor('up', 'dark', undefined)).toBe(THEME_TOKENS.dark.up);
    expect(resolveDrawingColor('up', 'light', undefined)).toBe(THEME_TOKENS.light.up);
  });
});

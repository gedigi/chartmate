import { describe, expect, it } from 'vitest';
import { resolveDrawingColor } from '../../src/chart/drawingColors';
import {
  COLOR_ONLY_KEY, COLOR_REF_KEY, colorToOverlay, lineToOverlay, normalizeOverlayStyles, readLine, readText, sanitizeDrawingStyles, textToOverlay, toOverlayStyles,
} from '../../src/chart/drawingStyles';
import { INDICATOR_PALETTE, THEME_TOKENS } from '../../src/chart/theme';
import { readableTextOn } from '../../src/chart/contrast';

const dark = (c: string) => resolveDrawingColor(c, 'dark');
const light = (c: string) => resolveDrawingColor(c, 'light');

describe('drawing styles with palette references', () => {
  it('a reference is drawn as the theme color and rides along in the overlay styles', () => {
    const o = lineToOverlay({ color: 'palette:1', size: 2, style: 'solid' }, dark) as Record<string, unknown>;
    expect(o.line).toMatchObject({ color: INDICATOR_PALETTE.dark[1], size: 2 });
    expect(o[COLOR_REF_KEY]).toBe('palette:1');
    expect(readLine(o)).toEqual({ color: 'palette:1', size: 2, style: 'solid' });
    expect(normalizeOverlayStyles('segment', o)).toEqual({ line: { color: 'palette:1', size: 2, style: 'solid' } });
    const l = lineToOverlay({ color: 'palette:1', size: 2, style: 'solid' }, light) as { line: { color: string } };
    expect(l.line.color).toBe(INDICATOR_PALETTE.light[1]);
  });

  it('text bubbles: the fill resolves and the glyphs contrast with the resolved fill', () => {
    for (const [resolve, theme] of [[dark, 'dark'], [light, 'light']] as const) {
      const o = textToOverlay({ color: 'text', size: 14 }, resolve) as Record<string, any>;
      const fill = THEME_TOKENS[theme].text;
      expect(o.text).toMatchObject({ backgroundColor: fill, borderColor: fill, color: readableTextOn(fill), size: 14 });
      expect(o.polygon).toMatchObject({ color: fill });
      expect(o[COLOR_REF_KEY]).toBe('text');
      expect(readText(o)).toEqual({ color: 'text', size: 14 });
      expect(normalizeOverlayStyles('simpleAnnotation', o)).toEqual({ text: { color: 'text', size: 14 } });
    }
  });

  it('a hex color (drawings saved before references) is drawn and saved exactly as before, with no reference', () => {
    const o = lineToOverlay({ color: '#ff0000', size: 1, style: 'dashed' }, dark) as Record<string, unknown>;
    expect(o).not.toHaveProperty(COLOR_REF_KEY);
    expect((o.line as { color: string }).color).toBe('#ff0000');
    expect(normalizeOverlayStyles('segment', o)).toEqual({ line: { color: '#ff0000', size: 1, style: 'dashed' } });
    // A drawing switched from a reference back to a hex: a null reference (it replaces the old one) reads as the hex.
    expect(readLine({ ...o, [COLOR_REF_KEY]: null })).toEqual({ color: '#ff0000', size: 1, style: 'dashed' });
  });

  it('stored styles: references and hex colors are both valid; unknown references are dropped', () => {
    expect(sanitizeDrawingStyles({ line: { color: 'up', size: 1, style: 'solid' } })).toEqual({ line: { color: 'up', size: 1, style: 'solid' } });
    expect(sanitizeDrawingStyles({ text: { color: 'palette:5', size: 12 } })).toEqual({ text: { color: 'palette:5', size: 12 } });
    expect(sanitizeDrawingStyles({ line: { color: '#ABCDEF', size: 1, style: 'solid' } })).toEqual({ line: { color: '#abcdef', size: 1, style: 'solid' } });
    expect(sanitizeDrawingStyles({ line: { color: 'palette:6', size: 1, style: 'solid' } })).toBeUndefined();
    expect(sanitizeDrawingStyles({ text: { color: 'bg', size: 12 } })).toBeUndefined();
  });

  it('toOverlayStyles resolves stored references and keeps label / extend options', () => {
    const o = toOverlayStyles({ line: { color: 'down', size: 1, style: 'solid' }, label: { onAxis: false } }, light) as Record<string, any>;
    expect(o.line.color).toBe(THEME_TOKENS.light.down);
    expect(o[COLOR_REF_KEY]).toBe('down');
    expect(o.chartmateLabel).toEqual({ onAxis: false });
  });

  it('a reference key that is not a valid token is ignored (the drawn hex is read)', () => {
    const o = { line: { color: '#123456', size: 1, style: 'solid' }, [COLOR_REF_KEY]: 'bogus' };
    expect(readLine(o)).toEqual({ color: '#123456', size: 1, style: 'solid' });
  });

  it('a color of its own only: the colors are set, width / dash / font size are left to the chart defaults', () => {
    const o = colorToOverlay('palette:2', dark) as Record<string, any>;
    expect(o.line).toEqual({ color: INDICATOR_PALETTE.dark[2] });
    expect(o.text).toEqual({ color: readableTextOn(INDICATOR_PALETTE.dark[2]), backgroundColor: INDICATOR_PALETTE.dark[2], borderColor: INDICATOR_PALETTE.dark[2] });
    expect(o[COLOR_ONLY_KEY]).toBe('palette:2');
    expect(readLine(o)).toBeNull();
    expect(readText(o)).toBeNull();
    expect(normalizeOverlayStyles('segment', o)).toEqual({ color: 'palette:2' });
    expect(normalizeOverlayStyles('simpleAnnotation', o)).toEqual({ color: 'palette:2' });
    expect(normalizeOverlayStyles('priceLine', { ...o, chartmateLabel: { onLine: false } })).toEqual({ color: 'palette:2', label: { onLine: false } });
    // A hex works the same (no reference).
    const h = colorToOverlay('#ABCDEF', dark) as Record<string, any>;
    expect(h.line).toEqual({ color: '#abcdef' });
    expect(h[COLOR_REF_KEY]).toBeNull();
    expect(normalizeOverlayStyles('segment', h)).toEqual({ color: '#abcdef' });
    // A full line style wins over a stale own-color key.
    const full = { ...lineToOverlay({ color: '#ff0000', size: 2, style: 'solid' }), [COLOR_ONLY_KEY]: 'palette:2' };
    expect(normalizeOverlayStyles('segment', full)).toEqual({ line: { color: '#ff0000', size: 2, style: 'solid' } });
  });

  it('stored color-only styles round-trip through sanitize / toOverlayStyles', () => {
    expect(sanitizeDrawingStyles({ color: 'down', extend: { right: true } })).toEqual({ color: 'down', extend: { right: true } });
    expect(sanitizeDrawingStyles({ color: 'palette:7' })).toBeUndefined();
    const o = toOverlayStyles({ color: 'down' }, light) as Record<string, any>;
    expect(o.line).toEqual({ color: THEME_TOKENS.light.down });
    expect(o[COLOR_ONLY_KEY]).toBe('down');
    expect(normalizeOverlayStyles('rayLine', o)).toEqual({ color: 'down' });
  });
});

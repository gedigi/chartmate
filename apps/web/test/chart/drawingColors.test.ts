import { DRAWING_COLOR_TOKENS } from '@chartmate/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAWING_COLOR, drawingSwatches, resolveDrawingColor } from '../../src/chart/drawingColors';
import { INDICATOR_PALETTE, THEME_TOKENS } from '../../src/chart/theme';

describe('drawing colors', () => {
  it('resolves palette references against the theme', () => {
    for (const theme of ['dark', 'light'] as const) {
      const t = THEME_TOKENS[theme];
      expect(resolveDrawingColor('accent', theme)).toBe(t.accent);
      expect(resolveDrawingColor('text', theme)).toBe(t.text);
      expect(resolveDrawingColor('muted', theme)).toBe(t.muted);
      expect(resolveDrawingColor('up', theme)).toBe(t.up);
      expect(resolveDrawingColor('down', theme)).toBe(t.down);
      INDICATOR_PALETTE[theme].forEach((c, i) => expect(resolveDrawingColor(`palette:${i}`, theme)).toBe(c));
    }
    expect(resolveDrawingColor('palette:2', 'dark')).not.toBe(resolveDrawingColor('palette:2', 'light'));
  });

  it('up / down follow the user\'s candle colors of that theme', () => {
    const appearance = { dark: { upColor: '#00ff00', downColor: '#ff0000' } };
    expect(resolveDrawingColor('up', 'dark', appearance)).toBe('#00ff00');
    expect(resolveDrawingColor('down', 'dark', appearance)).toBe('#ff0000');
    expect(resolveDrawingColor('up', 'light', appearance)).toBe(THEME_TOKENS.light.up);
  });

  it('a hex (drawings saved before references) renders exactly as stored, in every theme', () => {
    expect(resolveDrawingColor('#AbCdEf', 'dark')).toBe('#abcdef');
    expect(resolveDrawingColor('#abcdef', 'light')).toBe('#abcdef');
  });

  it('anything else falls back to the theme accent', () => {
    expect(resolveDrawingColor('palette:9', 'light')).toBe(THEME_TOKENS.light.accent);
    expect(resolveDrawingColor('', 'dark')).toBe(THEME_TOKENS.dark.accent);
    expect(DEFAULT_DRAWING_COLOR).toBe('accent');
  });

  it('swatches: every token once, in order, resolved and named per theme', () => {
    for (const theme of ['dark', 'light'] as const) {
      const s = drawingSwatches(theme);
      expect([...s.map((x) => x.token)].sort()).toEqual([...DRAWING_COLOR_TOKENS].sort());
      for (const x of s) expect(x.color).toBe(resolveDrawingColor(x.token, theme));
      expect(new Set(s.map((x) => x.name)).size).toBe(s.length);
      expect(new Set(s.map((x) => x.color)).size).toBe(s.length);
    }
    expect(drawingSwatches('dark').find((x) => x.token === 'text')!.name).toBe('White');
    expect(drawingSwatches('light').find((x) => x.token === 'text')!.name).toBe('Black');
    expect(drawingSwatches('dark').map((x) => x.name)).toEqual([
      'Sky', 'White', 'Gray', 'Up color', 'Down color', 'Pink', 'Cyan', 'Orange', 'Gold', 'Violet', 'Blue',
    ]);
    // Up / down end the first row; the cyan and pink hues are neither beside nor under them.
    const order = drawingSwatches('dark').map((x) => x.token);
    const below = (t: string) => order[order.indexOf(t as never) + 5];
    expect(order.slice(3, 5)).toEqual(['up', 'down']);
    expect([below('up'), below('down')]).toEqual(['palette:0', 'palette:1']); // gold, violet
    // Cyan and pink are in the first two columns of the palette row, away from up / down (columns 4 and 5).
    for (const t of ['palette:2', 'palette:4']) expect(order.indexOf(t as never) - 5).toBeLessThan(2);
  });
});

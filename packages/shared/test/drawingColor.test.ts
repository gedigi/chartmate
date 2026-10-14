import { describe, expect, it } from 'vitest';
import { DRAWING_COLOR_RE, DRAWING_COLOR_TOKENS, isDrawingColor, isDrawingColorToken } from '../src/types.js';

describe('drawing color references', () => {
  it('lists the accent, the neutrals, up / down and the six palette slots', () => {
    expect(DRAWING_COLOR_TOKENS).toEqual([
      'accent', 'text', 'muted', 'up', 'down', 'palette:0', 'palette:1', 'palette:2', 'palette:3', 'palette:4', 'palette:5',
    ]);
  });

  it('accepts exactly the listed tokens', () => {
    for (const t of DRAWING_COLOR_TOKENS) expect(isDrawingColorToken(t)).toBe(true);
    for (const bad of ['palette:6', 'palette:-1', 'palette:01', 'Accent', 'accent ', 'bg', 'palette', 'palette:', '', null, 3]) {
      expect(isDrawingColorToken(bad)).toBe(false);
    }
  });

  it('a drawing color is a token or a #rrggbb hex (old drawings)', () => {
    expect(isDrawingColor('#12abEF')).toBe(true);
    expect(isDrawingColor('palette:3')).toBe(true);
    expect(isDrawingColor('up')).toBe(true);
    for (const bad of ['#fff', 'red', 'rgb(0,0,0)', 'palette:9', undefined]) expect(isDrawingColor(bad)).toBe(false);
    expect(DRAWING_COLOR_RE.test('#a1b2c3')).toBe(true);
    expect(DRAWING_COLOR_RE.test('muted')).toBe(true);
    expect(DRAWING_COLOR_RE.test('mutedx')).toBe(false);
  });
});

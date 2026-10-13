import { describe, expect, it } from 'vitest';
import { fromOklch, oklch, parseColor, softTone, tintFill } from '../../src/chart/color';
import { THEME_TOKENS } from '../../src/chart/theme';

const hueDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
/** What a canvas paints for `rgba` over the opaque `bg`. */
const composite = (rgba: string, bg: string) => {
  const f = parseColor(rgba)!;
  const b = parseColor(bg)!;
  return f.rgb.map((v, i) => v * f.alpha + b.rgb[i]! * (1 - f.alpha));
};

describe('parseColor', () => {
  it('reads #rrggbb, #rgb, rgb() and rgba(); null otherwise', () => {
    expect(parseColor('#ff3b5c')).toEqual({ rgb: [255, 59, 92], alpha: 1 });
    expect(parseColor('#0f8')).toEqual({ rgb: [0, 255, 136], alpha: 1 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ rgb: [1, 2, 3], alpha: 1 });
    expect(parseColor('rgba(255,59,92,0.7)')).toEqual({ rgb: [255, 59, 92], alpha: 0.7 });
    expect(parseColor('red')).toBeNull();
  });
});

describe('oklch / fromOklch', () => {
  it('round-trips in-gamut colors and clips out-of-gamut chroma, keeping the hue', () => {
    for (const hex of ['#00d68f', '#ff3b5c', '#00a870', '#d4113b', '#2b66ff', '#0f1218']) {
      const [L, C, H] = oklch(hex);
      expect(fromOklch(L, C, H)).toBe(hex);
    }
    const clipped = fromOklch(0.7, 0.4, 20);
    expect(hueDiff(oklch(clipped)[2], 20)).toBeLessThan(2);
  });
});

describe('softTone', () => {
  it('is opaque, keeps the hue (within 1.5°) and moves the lightness toward the background on both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { bg, up, down } = THEME_TOKENS[theme];
      for (const strong of [up, down]) {
        const soft = softTone(strong, bg);
        expect(soft).toMatch(/^#[0-9a-f]{6}$/);
        const [L, , H] = oklch(strong);
        const [Ls, , Hs] = oklch(soft);
        const [Lb] = oklch(bg);
        expect(hueDiff(Hs, H)).toBeLessThan(1.5);
        expect(Math.abs(Ls - Lb)).toBeLessThan(Math.abs(L - Lb));
        expect(Math.abs(Ls - Lb)).toBeGreaterThan(0.3 * Math.abs(L - Lb)); // still clearly a bar, not background
      }
    }
  });

  it('never turns red pink on white: unlike an rgba() fill, which rotates the hue by > 5°', () => {
    const { bg, down } = THEME_TOKENS.light;
    const [r, g, b] = parseColor(down)!.rgb;
    const alphaLook = composite(`rgba(${r},${g},${b},0.45)`, bg);
    const alphaHex = `#${alphaLook.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    expect(hueDiff(oklch(alphaHex)[2], oklch(down)[2])).toBeGreaterThan(5);
    expect(hueDiff(oklch(softTone(down, bg))[2], oklch(down)[2])).toBeLessThan(1.5);
  });

  it('composites a translucent input onto the background first; unparseable input is returned as is', () => {
    expect(softTone('rgba(255,59,92,1)', '#0f1218')).toBe(softTone('#ff3b5c', '#0f1218'));
    expect(softTone('red', '#ffffff')).toBe('red');
  });
});

describe('tintFill', () => {
  it('on white: a translucent fill that lands exactly on a tint of the same hue as the strong color', () => {
    const { bg, up, down } = THEME_TOKENS.light;
    for (const strong of [up, down]) {
      const fill = tintFill(strong, bg, 0.8, 0.2);
      const f = parseColor(fill)!;
      expect(f.alpha).toBeGreaterThan(0);
      expect(f.alpha).toBeLessThan(0.6);
      const on = `#${composite(fill, bg).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      expect(hueDiff(oklch(on)[2], oklch(strong)[2])).toBeLessThan(3);
    }
  });

  it('on an off-white background (little headroom above it) the tint still keeps the hue: the darkening channels set the opacity', () => {
    for (const strong of ['#b3124d', '#0b9da0']) {
      const fill = tintFill(strong, '#fafbfd', 0.8, 0.2);
      expect(parseColor(fill)!.alpha).toBeLessThan(0.6);
      const on = `#${composite(fill, '#fafbfd').map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      expect(hueDiff(oklch(on)[2], oklch(strong)[2])).toBeLessThan(3);
    }
  });

  it('falls back to the color at the fallback alpha when no such fill exists (the dark theme\'s aqua)', () => {
    const { bg, up } = THEME_TOKENS.dark;
    expect(tintFill(up, bg, 0.8, 0.2)).toBe('rgba(60,207,208,0.2)');
    expect(tintFill('red', bg, 0.8, 0.2)).toBe('red');
  });
});

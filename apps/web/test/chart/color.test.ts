import { describe, expect, it } from 'vitest';
import { colorDistance, fromOklch, oklch, parseColor, softTone, tintFill, zoneTint } from '../../src/chart/color';
import { contrastRatio } from '../../src/chart/contrast';
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
    for (const strong of ['#c43d68', '#0b9da0']) {
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

describe('soft tone legibility', () => {
  it('reads as a bar of the same hue on both themes: ≥ 3:1 on the dark chart, clearly apart from the strong color', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { bg, up, down } = THEME_TOKENS[theme];
      for (const strong of [up, down]) {
        const soft = softTone(strong, bg);
        expect(contrastRatio(soft, bg), `${theme} ${soft} on bg`).toBeGreaterThanOrEqual(theme === 'dark' ? 3 : 2);
        expect(contrastRatio(soft, strong), `${theme} ${soft} vs ${strong}`).toBeGreaterThanOrEqual(1.4);
        expect(oklch(soft)[1], `${theme} ${soft} chroma`).toBeGreaterThan(0.8 * oklch(strong)[1]);
      }
    }
  });
});

describe('zoneTint', () => {
  const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const dist = (a: string, b: string) => colorDistance(parseColor(a)!.rgb, parseColor(b)!.rgb);

  it('one perceived weight for up and down on both themes, never above the maximum opacity', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { bg, up, down } = THEME_TOKENS[theme];
      for (const strong of [up, down]) {
        const fill = zoneTint(strong, bg, 0.05, 0.12);
        expect(parseColor(fill)!.alpha).toBeLessThanOrEqual(0.12);
        expect(dist(hex(composite(fill, bg)), bg), `${theme} ${strong}`).toBeCloseTo(0.05, 2);
      }
    }
  });

  it('candles under a zone keep their color (the other direction\'s candle moves < 0.05 in OKLab, < 7° in hue)', () => {
    for (const theme of ['dark', 'light'] as const) {
      const { bg, up, down } = THEME_TOKENS[theme];
      for (const [zone, candle] of [[up, down], [down, up]] as const) {
        const under = hex(composite(zoneTint(zone, bg, 0.05, 0.12), candle));
        expect(dist(under, candle), `${theme} ${candle} under ${zone}`).toBeLessThan(0.05);
        expect(hueDiff(oklch(under)[2], oklch(candle)[2])).toBeLessThan(7);
      }
    }
  });

  it('caps the opacity when the weight needs more; unparseable input is returned as is', () => {
    expect(parseColor(zoneTint('#0b9da0', '#ffffff', 0.5, 0.1))!.alpha).toBeLessThanOrEqual(0.1);
    expect(zoneTint('red', '#ffffff', 0.05, 0.12)).toBe('red');
  });
});

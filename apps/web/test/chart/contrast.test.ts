import { describe, expect, it } from 'vitest';
import { contrastRatio, DARK_TEXT, LIGHT_TEXT, readableTextOn, readableTextOnAll, relativeLuminance } from '../../src/chart/contrast';

describe('contrast helpers', () => {
  it('relative luminance follows WCAG (black 0, white 1)', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });

  it('contrast ratio is symmetric, 21 for black/white and 1 for equal colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#e63b7a', '#e63b7a')).toBe(1);
  });

  it('readableTextOn picks the text colour with the higher contrast', () => {
    expect(LIGHT_TEXT).toBe('#ffffff');
    expect(DARK_TEXT).toBe('#131722');
    expect(readableTextOn('#ffffff')).toBe(DARK_TEXT);
    expect(readableTextOn('#000000')).toBe(LIGHT_TEXT);
    expect(readableTextOn('#ffff00')).toBe(DARK_TEXT); // bright yellow
    expect(readableTextOn('#2962ff')).toBe(LIGHT_TEXT); // accent blue
    expect(readableTextOn('#26a69a')).toBe(DARK_TEXT); // default up green: dark text reads better
    expect(readableTextOn('#ef5350')).toBe(DARK_TEXT);
    expect(readableTextOn('#363a45')).toBe(LIGHT_TEXT); // dark crosshair background
    expect(readableTextOn('#808080')).toBe(DARK_TEXT); // mid grey
    expect(readableTextOn('#595959')).toBe(LIGHT_TEXT);
    expect(readableTextOn('#FFFFFF')).toBe(DARK_TEXT); // case-insensitive
  });

  it('readableTextOnAll maximises the worst-case contrast over several backgrounds', () => {
    // The user's colours: white up, pink down. White text would vanish on the up label.
    expect(readableTextOnAll(['#ffffff', '#e63b7a'])).toBe(DARK_TEXT);
    expect(readableTextOnAll(['#000000', '#1a237e'])).toBe(LIGHT_TEXT);
    expect(readableTextOnAll(['#ffffff'])).toBe(readableTextOn('#ffffff'));
  });

  it('non-hex inputs fall back to light text without throwing', () => {
    expect(readableTextOn('transparent')).toBe(LIGHT_TEXT);
  });
});

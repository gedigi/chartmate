import { describe, expect, it } from 'vitest';
import { contrastRatio, DARK_TEXT, LIGHT_TEXT, readableTextOn, WHITE_TEXT_MIN_CONTRAST, readableTextOnAll, relativeLuminance } from '../../src/chart/contrast';

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

  it('readableTextOn keeps white while it reaches 3:1, else picks the higher-contrast colour', () => {
    expect(LIGHT_TEXT).toBe('#ffffff');
    expect(DARK_TEXT).toBe('#131722');
    expect(WHITE_TEXT_MIN_CONTRAST).toBe(2.99);
    expect(readableTextOn('#ffffff')).toBe(DARK_TEXT);
    expect(readableTextOn('#000000')).toBe(LIGHT_TEXT);
    expect(readableTextOn('#ffff00')).toBe(DARK_TEXT); // bright yellow
    expect(readableTextOn('#2962ff')).toBe(LIGHT_TEXT); // accent blue
    expect(readableTextOn('#363a45')).toBe(LIGHT_TEXT); // dark crosshair background
    // White reaches 3:1 here although dark contrasts more: white is kept (TradingView-style labels).
    expect(readableTextOn('#808080')).toBe(LIGHT_TEXT); // mid grey: white 3.95, dark 4.53
    expect(readableTextOn('#ef5350')).toBe(LIGHT_TEXT); // white 3.49, dark 5.13
    expect(readableTextOn('#26a69a')).toBe(LIGHT_TEXT); // white 2.9985: inside the 0.01 tolerance
    // Below 3:1 for white: the better of the two.
    expect(readableTextOn('#2ba89c')).toBe(DARK_TEXT); // white 2.92
    expect(readableTextOn('#a0a0a0')).toBe(DARK_TEXT); // white 2.62
    expect(readableTextOn('#FFFFFF')).toBe(DARK_TEXT); // case-insensitive
  });

  it('the threshold is 2.99, compared unrounded (pinned on both sides)', () => {
    expect(contrastRatio('#ffffff', '#26a69a')).toBeCloseTo(2.9985, 4);
    expect(readableTextOn('#26a69a')).toBe(LIGHT_TEXT);
    // ~2.98: below the threshold → the better of the two (dark).
    expect(contrastRatio('#ffffff', '#1ea6a4')).toBeCloseTo(2.98, 2);
    expect(readableTextOn('#1ea6a4')).toBe(DARK_TEXT);
    // 2.985…2.99: just below → dark (unrounded compare).
    expect(contrastRatio('#ffffff', '#1ea6a2')).toBeGreaterThan(2.985);
    expect(contrastRatio('#ffffff', '#1ea6a2')).toBeLessThan(2.99);
    expect(readableTextOn('#1ea6a2')).toBe(DARK_TEXT);
    // 2.99…2.995: at / above 2.99 → white (the old 2-decimal rounding against 3 gave dark here).
    expect(contrastRatio('#ffffff', '#27a69b')).toBeGreaterThan(2.99);
    expect(contrastRatio('#ffffff', '#27a69b')).toBeLessThan(2.995);
    expect(readableTextOn('#27a69b')).toBe(LIGHT_TEXT);
  });

  it('readableTextOnAll applies the rule to the worst case over several backgrounds', () => {
    // Default last-price label colours (up / down / unchanged) of each theme: white text.
    expect(readableTextOnAll(['#26a69a', '#ef5350', '#868b98'])).toBe(LIGHT_TEXT);
    expect(readableTextOnAll(['#089981', '#f23645', '#6a6d78'])).toBe(LIGHT_TEXT);
    // The user's colours: white up, pink down. White text would vanish on the up label.
    expect(readableTextOnAll(['#ffffff', '#e63b7a'])).toBe(DARK_TEXT);
    expect(readableTextOnAll(['#000000', '#1a237e'])).toBe(LIGHT_TEXT);
    expect(readableTextOnAll(['#ffffff'])).toBe(readableTextOn('#ffffff'));
  });

  it('a preferred colour other than white is kept while it reaches 3:1 (e.g. muted marker text)', () => {
    expect(readableTextOnAll(['#131722'], '#868b98')).toBe('#868b98');
    expect(readableTextOnAll(['#ffffff'], '#6a6d78')).toBe('#6a6d78');
    expect(readableTextOnAll(['#131722'], '#1a1e2a')).toBe(LIGHT_TEXT);
    expect(readableTextOnAll(['#ffffff'], '#eeeeee')).toBe(DARK_TEXT);
  });

  it('non-hex inputs fall back to light text without throwing', () => {
    expect(readableTextOn('transparent')).toBe(LIGHT_TEXT);
  });
});

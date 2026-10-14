import { DRAWING_COLOR_TOKENS, isHexColor, type DrawingColorToken, type ThemedAppearance } from '@chartmate/shared';
import { indicatorPaletteColor, resolveAppearance, themeTokens, type ThemeName } from './theme';

/** Color of new drawings until the user picks one (and after "Reset to default"). */
export const DEFAULT_DRAWING_COLOR: DrawingColorToken = 'accent';

/** One swatch of the drawing color picker: the stored reference, its color in the active theme and its plain name. */
export interface DrawingSwatch { token: DrawingColorToken; color: string; name: string }

const PALETTE_NAMES = ['Gold', 'Violet', 'Cyan', 'Orange', 'Pink', 'Blue'] as const;

/**
 * The color a drawing color stands for in `theme`: a palette reference resolves to that theme's token (up / down: the
 * candle colors, the user's own ones included); a hex (drawings saved before references, the appearance default) is
 * drawn exactly as stored. Anything else → the theme accent.
 */
export function resolveDrawingColor(c: string, theme: ThemeName, appearance?: ThemedAppearance): string {
  if (isHexColor(c)) return c.toLowerCase();
  const t = themeTokens(theme);
  switch (c) {
    case 'accent': return t.accent;
    case 'text': return t.text;
    case 'muted': return t.muted;
    case 'up': return resolveAppearance(theme, appearance).upColor;
    case 'down': return resolveAppearance(theme, appearance).downColor;
  }
  const slot = /^palette:([0-5])$/.exec(c);
  return slot ? indicatorPaletteColor(theme, Number(slot[1])) : t.accent;
}

function swatchName(token: DrawingColorToken, theme: ThemeName): string {
  switch (token) {
    case 'accent': return 'Sky';
    case 'text': return theme === 'dark' ? 'White' : 'Black';
    case 'muted': return 'Gray';
    case 'up': return 'Up color';
    case 'down': return 'Down color';
    default: return PALETTE_NAMES[Number(token.slice('palette:'.length))]!;
  }
}

/** The picker's swatches for `theme`, in DRAWING_COLOR_TOKENS order (theme colors first, then the palette hues). */
export function drawingSwatches(theme: ThemeName, appearance?: ThemedAppearance): DrawingSwatch[] {
  return DRAWING_COLOR_TOKENS.map((token) => ({ token, color: resolveDrawingColor(token, theme, appearance), name: swatchName(token, theme) }));
}

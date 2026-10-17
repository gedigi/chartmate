import type { DrawingColorToken, ThemedAppearance } from '@chartmate/shared';
import { resolvePaletteColor, type ThemeName } from './theme';

/** Color of new drawings until the user picks one (and after "Reset to default"). */
export const DEFAULT_DRAWING_COLOR: DrawingColorToken = 'accent';

/** One swatch of the drawing color picker: the stored reference, its color in the active theme and its plain name. */
export interface DrawingSwatch { token: DrawingColorToken; color: string; name: string }

const PALETTE_NAMES = ['Gold', 'Violet', 'Cyan', 'Orange', 'Pink', 'Blue'] as const;

/** The color a drawing color stands for in `theme` (see resolvePaletteColor). */
export const resolveDrawingColor = resolvePaletteColor;

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

/**
 * Order of the picker's two rows: the theme colors with up / down at the end of the first, then the palette hues
 * arranged so the cyan and pink ones never sit next to (or under) up and down, which they could be mistaken for.
 */
export const SWATCH_ORDER: readonly DrawingColorToken[] = [
  'accent', 'text', 'muted', 'up', 'down',
  'palette:4', 'palette:2', 'palette:3', 'palette:0', 'palette:1', 'palette:5',
];

/** The picker's swatches for `theme`, in SWATCH_ORDER (theme colors first, then the palette hues). */
export function drawingSwatches(theme: ThemeName, appearance?: ThemedAppearance): DrawingSwatch[] {
  return SWATCH_ORDER.map((token) => ({ token, color: resolveDrawingColor(token, theme, appearance), name: swatchName(token, theme) }));
}

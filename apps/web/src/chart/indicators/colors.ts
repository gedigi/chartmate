import type { ThemedAppearance } from '@chartmate/shared';
import { readableTextOnAll } from '../contrast';
import { INDICATOR_PALETTE, resolveAppearance, themeSoftTone, themeTokens, type ThemeName } from '../theme';

/**
 * The palette an indicator draws with, resolved for one theme and appearance: the up / down family (strong, soft
 * tone, text tone — the user's custom candle colors when set), the neutral tokens and the categorical line palette.
 * Custom indicators that paint on the canvas themselves (Wyckoff) take every color from here, at draw time.
 */
export interface IndicatorColors {
  theme: ThemeName;
  bg: string; text: string; muted: string; level: string;
  up: string; down: string; upSoft: string; downSoft: string;
  /** Small text in the up / down family: the theme's text tone (upFg / downFg), or a custom color that reads on bg. */
  upText: string; downText: string;
  palette: readonly string[];
}

const textTone = (strong: string, themeStrong: string, themeFg: string, bg: string): string =>
  strong.toLowerCase() === themeStrong.toLowerCase() ? themeFg : readableTextOnAll([bg], strong);

export function indicatorColors(theme: ThemeName, appearance: ThemedAppearance | undefined): IndicatorColors {
  const t = themeTokens(theme);
  const a = resolveAppearance(theme, appearance);
  return {
    theme, bg: t.bg, text: t.text, muted: t.muted, level: t.level,
    up: a.upColor, down: a.downColor,
    upSoft: themeSoftTone(theme, a.upColor), downSoft: themeSoftTone(theme, a.downColor),
    upText: textTone(a.upColor, t.up, t.upFg, t.bg), downText: textTone(a.downColor, t.down, t.downFg, t.bg),
    palette: INDICATOR_PALETTE[theme],
  };
}

/**
 * Theme and appearance of the chart (one per page), kept current by the ChartAdapter (init, setTheme, setAppearance).
 * Draw callbacks read it on every paint, so a theme toggle — which repaints the chart — recolors them.
 */
export const indicatorColorContext: { theme: ThemeName; appearance: ThemedAppearance | undefined } = { theme: 'dark', appearance: undefined };

/** The palette of the chart as it is now (see indicatorColorContext). */
export function activeIndicatorColors(): IndicatorColors {
  return indicatorColors(indicatorColorContext.theme, indicatorColorContext.appearance);
}

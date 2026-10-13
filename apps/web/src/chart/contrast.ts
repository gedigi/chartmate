/** Text colours for labels drawn on a coloured background (the dark one is the dark theme's background). */
export const LIGHT_TEXT = '#ffffff';
export const DARK_TEXT = '#131722';
export type LabelTextColour = typeof LIGHT_TEXT | typeof DARK_TEXT;

const HEX = /^#[0-9a-f]{6}$/i;

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance of '#rrggbb' (0 = black … 1 = white); non-hex input counts as black. */
export function relativeLuminance(hex: string): number {
  if (!HEX.test(hex)) return 0;
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2 contrast ratio of two '#rrggbb' colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Contrast ratio at which the preferred label text colour (white by default) is kept: the WCAG 3:1 level for
 * UI components / large text, with a deliberate 0.01 tolerance so the dark theme's default up colour #26a69a
 * (TradingView's teal, 2.9985:1 against white) keeps white text as TradingView does. Compared unrounded.
 */
export const WHITE_TEXT_MIN_CONTRAST = 2.99;

/** Label text colour on `bg`: white at about 3:1 or more, else whichever of white / near-black contrasts more. */
export function readableTextOn(bg: string): LabelTextColour {
  return readableTextOnAll([bg]);
}

/**
 * One text colour for labels whose background varies (e.g. KLineChart's last-price label: up / down /
 * unchanged colour, but a single text colour). `preferred` (white by default) is kept while its worst-case
 * contrast over `bgs` is at least WHITE_TEXT_MIN_CONTRAST; otherwise the one of white / near-black with the higher worst case
 * (ties keep white).
 */
export function readableTextOnAll(bgs: readonly string[]): LabelTextColour;
export function readableTextOnAll(bgs: readonly string[], preferred: string): string;
export function readableTextOnAll(bgs: readonly string[], preferred: string = LIGHT_TEXT): string {
  const worst = (text: string) => Math.min(...bgs.map((bg) => contrastRatio(text, bg)));
  if (worst(preferred) >= WHITE_TEXT_MIN_CONTRAST) return preferred;
  return worst(DARK_TEXT) > worst(LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

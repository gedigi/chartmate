import type { CandleBodyStyle, ChartAppearance, ChartType, DrawingLineStyle, ThemedAppearance } from '@chartmate/shared';
import type { DeepPartial, Styles } from 'klinecharts';
import { readableTextOn, readableTextOnAll } from './contrast';
import { klineLine } from './drawingStyles';

export type ThemeName = 'dark' | 'light';

/**
 * Fallback chart tokens. The ones with a CSS custom property (THEME_CSS_VARS) are read from src/styles.css at
 * runtime (refreshThemeTokens); these constants are only used when that is not possible, and a parity test
 * keeps them equal to styles.css.
 */
export const THEME_TOKENS = {
  dark: {
    bg: '#0f1218', panel: '#141820', elevated: '#1b2029', border: '#262c38', grid: '#181d26', text: '#e4e7ee', muted: '#8b93a3', accent: '#2b66ff',
    up: '#00d68f', down: '#ff3b5c', crossBg: '#2a303c',
  },
  light: {
    bg: '#ffffff', panel: '#f7f8fa', elevated: '#ffffff', border: '#e3e6eb', grid: '#f1f3f6', text: '#111827', muted: '#5b6474', accent: '#2b66ff',
    up: '#00a870', down: '#d4113b', crossBg: '#1f2937',
  },
} as const;

/*
 * Up / down (candles, volume / MACD / AO bars, position zones, watchlist and basket changes): a vivid emerald and a
 * vivid rose-red at near-maximum chroma. Besides the hue they differ in LIGHTNESS so they stay apart for red-green
 * color-blind readers: on dark the up color is the light one (OKLCH L 0.77 vs 0.66), on white the down color is
 * the dark one (L 0.56 vs 0.65; protanopia darkens reds, which only widens that gap). OKLab ΔE×100 up↔down: dark 40
 * (protan 28, deutan 10), light 35 (protan 25, deutan 9). Both are ≥ 3:1 against their background; the down red sits
 * between the palette's orange and pink at ΔE ≥ 12 (dark) / 14 (light) from both. Small TEXT uses the --up-fg /
 * --down-fg CSS tokens instead (≥ 4.5:1 on every surface they are drawn on).
 */

/**
 * Bump when the default colors change: layouts saved under an older revision get colors equal to an earlier
 * default read as "unset" ONCE (see useLayout's migrateColorDefaults), then carry this revision so a color the
 * user picks later — even an old default — is never touched again.
 */
export const COLOR_DEFAULTS_REV = 2;

/**
 * Default colors of earlier revisions (rev 0: the original release; rev 1: an unreleased intermediate set). A
 * stored appearance / bar color exactly equal to one of them was (almost certainly) never picked by the user —
 * the dialogs write the shown defaults along with the edited field — so the one-time migration unsets it.
 */
export const LEGACY_DEFAULTS = {
  dark: { up: ['#26a69a', '#34d399'], down: ['#ef5350', '#f23c50'], accent: ['#2962ff', '#3d6af5'] },
  light: { up: ['#089981', '#10a37a'], down: ['#f23645', '#c41d3d'], accent: ['#2962ff', '#3d6af5'] },
} as const satisfies Record<ThemeName, Record<'up' | 'down' | 'accent', readonly string[]>>;

const isOneOf = (a: string | undefined, list: readonly string[]): boolean => typeof a === 'string' && list.includes(a.toLowerCase());

/** One theme's stored appearance without the fields that equal that theme's legacy defaults (undefined when empty). */
export function dropLegacyAppearanceDefaults(theme: ThemeName, a: ChartAppearance): ChartAppearance | undefined {
  const old = LEGACY_DEFAULTS[theme];
  const out: ChartAppearance = { ...a };
  if (isOneOf(out.upColor, old.up)) delete out.upColor;
  if (isOneOf(out.downColor, old.down)) delete out.downColor;
  if (isOneOf(out.lineColor, old.accent)) delete out.lineColor;
  if (out.drawing && isOneOf(out.drawing.color, old.accent)) {
    // The whole default drawing style → unset; a custom width / dash keeps that, with today's accent.
    if (out.drawing.size === 1 && out.drawing.style === 'solid') delete out.drawing;
    else out.drawing = { ...out.drawing, color: THEME_TOKENS[theme].accent };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Legacy default bar color → the current default of the same theme, per direction. */
const legacyBarMap = (dir: 'up' | 'down'): ReadonlyMap<string, string> => new Map(
  (['dark', 'light'] as const).flatMap((t) => LEGACY_DEFAULTS[t][dir].map((c) => [c, THEME_TOKENS[t][dir]] as const)),
);
const LEGACY_BAR_UP = legacyBarMap('up');
const LEGACY_BAR_DOWN = legacyBarMap('down');

/**
 * An indicator's stored bar colors with legacy defaults resolved, direction-aware (`up` only matches a legacy UP
 * color, `down` a legacy DOWN color, so an inverted pair is the user's choice and is kept): both legacy defaults
 * → undefined (the bars follow the theme again); one legacy default next to a user color → that side becomes the
 * current default it stood for (bar colors are not per theme, so it cannot be left unset alone).
 */
export function dropLegacyBarColors(b: { up: string; down: string }): { up: string; down: string } | undefined {
  const up = LEGACY_BAR_UP.get(b.up.toLowerCase());
  const down = LEGACY_BAR_DOWN.get(b.down.toLowerCase());
  if (up !== undefined && down !== undefined) return undefined;
  return { up: up ?? b.up, down: down ?? b.down };
}

/**
 * Categorical palette of indicator LINES, per theme (surfaces #0f1218 / #ffffff): blue, orange, cyan, violet, amber,
 * pink — vivid (near-maximum OKLCH chroma per hue), deliberately without green / red so a line never reads as a
 * candle up / down. Adjacent slots stay apart under protan / deutan simulation (validator: worst adjacent ΔE 12.7
 * dark, 16.6 light). Dark cyan / amber are lighter than the validator's L band (0.70 / 0.74 vs ≤ 0.67) on purpose:
 * inside it those hues are dull. Slot n colors the n-th line of an indicator (see `lineSlots` in the catalog);
 * amber / pink are below 3:1 on white, acceptable because the legend / tooltip names every line. Histogram bars
 * keep the theme up / down colors (`defaultIndicatorBars`).
 */
export const INDICATOR_PALETTE = {
  dark: ['#2488f7', '#e56c19', '#00b3c2', '#8d7cf8', '#e49916', '#f631aa'],
  light: ['#1272da', '#eb6111', '#0095a0', '#541cdc', '#eda100', '#e12ca0'],
} as const satisfies Record<ThemeName, readonly string[]>;

/** Color of palette slot `slot` (0-based) in `theme`; wraps only as a safety net (the catalog has <= 6 lines per indicator). */
export function indicatorPaletteColor(theme: ThemeName, slot: number): string {
  const p = INDICATOR_PALETTE[theme];
  return p[((slot % p.length) + p.length) % p.length]!;
}

type ThemeTokens = { -readonly [K in keyof typeof THEME_TOKENS.dark]: string };

/** Chart token → CSS custom property in styles.css. */
export const THEME_CSS_VARS: Readonly<Partial<Record<keyof ThemeTokens, string>>> = {
  bg: '--bg', panel: '--bg-panel', elevated: '--bg-elevated', border: '--border', text: '--text', muted: '--text-muted', accent: '--accent',
  up: '--up', down: '--down', grid: '--grid', crossBg: '--cross-bg',
};

const live: Partial<Record<ThemeName, ThemeTokens>> = {};

/** The chart tokens of `theme`: the last values read from the CSS (refreshThemeTokens), else the constants. */
export function themeTokens(theme: ThemeName): ThemeTokens {
  return live[theme] ?? THEME_TOKENS[theme];
}

const isHexColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

/**
 * Re-reads the CSS custom properties for `theme` (adapter init / theme change). Only reads while the document
 * shows that theme (`data-theme`, dark by default), since the variables on :root belong to the active theme;
 * missing or non-hex values fall back to the constants.
 */
export function refreshThemeTokens(theme: ThemeName): void {
  const fallback = THEME_TOKENS[theme];
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if ((root.dataset['theme'] ?? 'dark') !== theme) return;
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(root);
  } catch {
    return;
  }
  const next: ThemeTokens = { ...fallback };
  for (const [key, cssVar] of Object.entries(THEME_CSS_VARS) as Array<[keyof ThemeTokens, string]>) {
    const v = style.getPropertyValue(cssVar).trim();
    if (isHexColor(v)) next[key] = v.toLowerCase();
  }
  live[theme] = next;
}

/** Every appearance field resolved (unset fields follow the theme). */
export interface ResolvedAppearance {
  upColor: string; downColor: string; candleBody: CandleBodyStyle; lineColor: string; lineWidth: number; drawing: DrawingLineStyle;
}

/**
 * Default up / down colors of indicator histograms (VOL, MACD, AO): the theme's up / down colors. Per-indicator
 * `barColors` overrides still win.
 */
export function defaultBarColors(theme: ThemeName): { up: string; down: string } {
  const { up, down } = themeTokens(theme);
  return { up, down };
}

/** Chart default histogram bar colors: the theme's up / down, as translucent as KLineChart's own defaults. */
export function defaultIndicatorBars(theme: ThemeName): { upColor: string; downColor: string } {
  const { up, down } = defaultBarColors(theme);
  return { upColor: hexToRgba(up, 0.7), downColor: hexToRgba(down, 0.7) };
}

export function defaultAppearance(theme: ThemeName): ResolvedAppearance {
  const { accent, up, down } = themeTokens(theme);
  return { upColor: up, downColor: down, candleBody: 'solid', lineColor: accent, lineWidth: 2, drawing: { color: accent, size: 1, style: 'solid' } };
}

/** The active theme's appearance with every unset field filled from that theme's defaults. */
export function resolveAppearance(theme: ThemeName, appearance: ThemedAppearance | undefined): ResolvedAppearance {
  return resolveThemeAppearance(theme, appearance?.[theme]);
}

/** One theme's appearance (e.g. what the dialog edits) with unset fields filled from the theme's defaults. */
export function resolveThemeAppearance(theme: ThemeName, a: ChartAppearance | undefined): ResolvedAppearance {
  const d = defaultAppearance(theme);
  return {
    upColor: a?.upColor ?? d.upColor,
    downColor: a?.downColor ?? d.downColor,
    candleBody: a?.candleBody ?? d.candleBody,
    lineColor: a?.lineColor ?? d.lineColor,
    lineWidth: a?.lineWidth ?? d.lineWidth,
    drawing: a?.drawing ?? d.drawing,
  };
}

const BODY_TYPE = {
  solid: 'candle_solid', hollow: 'candle_stroke', hollow_up: 'candle_up_stroke', hollow_down: 'candle_down_stroke',
} as const;

/** '#rrggbb' → 'rgba(r,g,b,alpha)'. */
export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Default font size of text annotations (KLineChart's own default). */
export const DEFAULT_TEXT_SIZE = 12;

/**
 * Chart-level overlay defaults from the (resolved) default drawing style, so drawings without their own
 * styles render exactly as the appearance dialog says (and follow it when it changes).
 */
export function overlayStyles(d: DrawingLineStyle): DeepPartial<Styles['overlay']> {
  const soft = hexToRgba(d.color, 0.35);
  return {
    line: { color: d.color, size: d.size, ...klineLine(d.style, d.size) },
    point: { color: d.color, borderColor: soft, activeColor: d.color, activeBorderColor: soft },
    // Annotation bubbles are filled with the drawing color: the glyphs take whichever of white / dark reads on it.
    text: { color: readableTextOn(d.color), backgroundColor: d.color, borderColor: d.color, size: DEFAULT_TEXT_SIZE },
    polygon: { color: d.color, borderColor: d.color },
    rect: { color: hexToRgba(d.color, 0.25), borderColor: d.color },
    circle: { color: hexToRgba(d.color, 0.25), borderColor: d.color },
    arc: { color: d.color },
  };
}

/** Candle-series styles for a chart type with the (theme-resolved) appearance applied. */
export function candleStyles(type: ChartType, theme: ThemeName, appearance: ThemedAppearance | undefined): DeepPartial<Styles['candle']> {
  const a = resolveAppearance(theme, appearance);
  const muted = themeTokens(theme).muted;
  const colors: DeepPartial<Styles['candle']> = {
    bar: {
      upColor: a.upColor, downColor: a.downColor, noChangeColor: muted,
      upBorderColor: a.upColor, downBorderColor: a.downColor, noChangeBorderColor: muted,
      upWickColor: a.upColor, downWickColor: a.downColor, noChangeWickColor: muted,
    },
    priceMark: { last: { upColor: a.upColor, downColor: a.downColor, noChangeColor: muted, text: { color: lastPriceTextColor(a.upColor, a.downColor, muted) } } },
  };
  switch (type) {
    case 'candle': return { ...colors, type: BODY_TYPE[a.candleBody] };
    case 'ohlc': return { ...colors, type: 'ohlc' };
    case 'line':
    case 'area': {
      const fill = type === 'line'
        ? [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0)' }]
        : [{ offset: 0, color: hexToRgba(a.lineColor, 0.02) }, { offset: 1, color: hexToRgba(a.lineColor, 0.28) }];
      return { ...colors, type: 'area', area: { lineColor: a.lineColor, lineSize: a.lineWidth, backgroundColor: fill } };
    }
  }
}

/**
 * KLineChart fills the last-price label with the up / down / no-change color but draws its text in a single
 * color, so the text cannot follow the bar direction: white while its worst-case contrast over the three
 * label colors is at least 3:1, else whichever of white / dark has the higher worst case.
 */
export function lastPriceTextColor(up: string, down: string, noChange: string): string {
  return readableTextOnAll([up, down, noChange]);
}

export function chartStyles(theme: ThemeName): DeepPartial<Styles> {
  const t = themeTokens(theme);
  const axis = {
    axisLine: { color: t.border },
    tickLine: { color: t.border },
    tickText: { color: t.muted },
  };
  const crossText = { color: readableTextOn(t.crossBg), backgroundColor: t.crossBg, borderColor: t.border };
  return {
    grid: {
      horizontal: { color: t.grid },
      vertical: { color: t.grid },
    },
    candle: {
      bar: {
        upColor: t.up, downColor: t.down, noChangeColor: t.muted,
        upBorderColor: t.up, downBorderColor: t.down, noChangeBorderColor: t.muted,
        upWickColor: t.up, downWickColor: t.down, noChangeWickColor: t.muted,
      },
      priceMark: {
        high: { color: t.muted },
        low: { color: t.muted },
        last: { upColor: t.up, downColor: t.down, noChangeColor: t.muted, text: { color: lastPriceTextColor(t.up, t.down, t.muted) } },
      },
      tooltip: { title: { color: t.text, template: '{displayName} · {tf}' }, legend: { color: t.muted } },
    },
    indicator: {
      // Default histogram bars: filled, in the theme's up / down colors, as translucent as KLineChart's own defaults.
      bars: [{ style: 'fill', ...defaultIndicatorBars(theme) }],
      tooltip: { title: { color: t.text }, legend: { color: t.muted } },
      lastValueMark: { show: false },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: t.border, activeBackgroundColor: hexToRgba(t.accent, 0.15) },
    crosshair: {
      horizontal: { line: { color: t.muted }, text: crossText },
      vertical: { line: { color: t.muted }, text: crossText },
    },
  };
}

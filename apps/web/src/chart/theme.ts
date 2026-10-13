import type { CandleBodyStyle, ChartAppearance, ChartType, DrawingLineStyle, LastPriceLineStyle, ThemedAppearance } from '@chartmate/shared';
import type { DeepPartial, Styles } from 'klinecharts';
import { readableTextOn, readableTextOnAll } from './contrast';
import { softTone } from './color';
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
    up: '#00d68f', down: '#ff3b5c', upSoft: '#008255', downSoft: '#aa0031', upFg: '#00d68f', downFg: '#ff7c85',
    crossBg: '#2a303c', crosshair: '#5f6878', level: '#4a5263', lastPrice: '#ffffff',
  },
  light: {
    bg: '#ffffff', panel: '#f7f8fa', elevated: '#ffffff', border: '#e3e6eb', grid: '#f1f3f6', text: '#111827', muted: '#5b6474', accent: '#2b66ff',
    up: '#00a870', down: '#d4113b', upSoft: '#65d39f', downSoft: '#ff787e', upFg: '#006944', downFg: '#b0002d',
    crossBg: '#1f2937', crosshair: '#8a93a3', level: '#b6bcc6', lastPrice: '#111827',
  },
} as const;

/*
 * Up / down (candles, volume / MACD / AO bars, position zones, watchlist and basket changes): a vivid emerald and a
 * vivid rose-red at near-maximum chroma. Besides the hue they differ in LIGHTNESS so they stay apart for red-green
 * color-blind readers: on dark the up color is the light one (OKLCH L 0.77 vs 0.66), on white the down color is
 * the dark one (L 0.56 vs 0.65; protanopia darkens reds, which only widens that gap). OKLab ΔE×100 up↔down: dark 40
 * (protan 28, deutan 10), light 35 (protan 25, deutan 9). Both are ≥ 3:1 against their background; the down red sits
 * between the palette's orange and pink at ΔE ≥ 12 (dark) / 14 (light) from both. Small TEXT uses the --up-fg /
 * --down-fg CSS tokens instead (≥ 4.5:1 on every surface they are drawn on, including a tinted pill on the current
 * watchlist row), hue-locked to the strong color.
 *
 * One family per direction: every strong up / down mark (candles, volume, MACD / AO, positions, watchlist, baskets,
 * sparklines) uses the SAME opaque color; the only other member is the soft tone (upSoft / downSoft: rising MACD /
 * AO bars), an OPAQUE color derived by softTone() (src/chart/color.ts) — same OKLCH hue, lightness moved toward the
 * chart background. Never an rgba() of the strong color: over white that reads pink, over the dark bg brown. The
 * upSoft / downSoft constants are softTone(up / down, bg) (a test checks it); custom colors get theirs at runtime.
 *
 * Neutral chart tokens: crosshair (thin dashed crosshair lines), level (muted dashed reference lines, e.g. oscillator
 * levels), lastPrice (the neutral last price line and label).
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
  up: '--up', down: '--down', upSoft: '--up-soft', downSoft: '--down-soft', upFg: '--up-fg', downFg: '--down-fg', grid: '--grid',
  crossBg: '--cross-bg', crosshair: '--crosshair', level: '--level', lastPrice: '--last-price',
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
  lastPriceLine: LastPriceLineStyle;
}

/**
 * Default up / down colors of indicator histograms (VOL, MACD, AO): the candle colors of `theme` — the user's
 * custom ones from `appearance` when set, else the theme's. Per-indicator `barColors` overrides still win; the soft
 * tone of rising MACD / AO bars is derived from whichever color is drawn (themeSoftTone).
 */
export function defaultBarColors(theme: ThemeName, appearance?: ThemedAppearance): { up: string; down: string } {
  const a = resolveAppearance(theme, appearance);
  return { up: a.upColor, down: a.downColor };
}

/**
 * Chart default histogram bar colors: the (resolved) candle up / down, OPAQUE — the exact candle colors (an rgba()
 * of them would read pink on white / brown on dark next to the candles).
 */
export function defaultIndicatorBars(theme: ThemeName, appearance?: ThemedAppearance): { upColor: string; downColor: string; noChangeColor: string } {
  const { up, down } = defaultBarColors(theme, appearance);
  return { upColor: up, downColor: down, noChangeColor: themeTokens(theme).muted };
}

/**
 * Color of indicator reference levels (dashed oscillator levels such as RSI 30 / 70): the theme's opaque, muted
 * `level` token, quieter than any data line.
 */
export function indicatorLevelColor(theme: ThemeName): string {
  return themeTokens(theme).level;
}

/** The soft tone of `color` on `theme`'s chart background (rising MACD / AO bars): see softTone. */
export function themeSoftTone(theme: ThemeName, color: string): string {
  return softTone(color, themeTokens(theme).bg);
}

export function defaultAppearance(theme: ThemeName): ResolvedAppearance {
  const { accent, up, down } = themeTokens(theme);
  return {
    upColor: up, downColor: down, candleBody: 'solid', lineColor: accent, lineWidth: 2, drawing: { color: accent, size: 1, style: 'solid' },
    lastPriceLine: 'neutral',
  };
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
    // Anything but 'candle' (missing, or an unknown value from an older / newer client) is the neutral default.
    lastPriceLine: a?.lastPriceLine === 'candle' ? 'candle' : d.lastPriceLine,
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
    text: { color: readableTextOn(d.color), backgroundColor: d.color, borderColor: d.color, size: DEFAULT_TEXT_SIZE, family: CHART_FONT },
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
    priceMark: { last: lastPriceMark(theme, a.lastPriceLine, a.upColor, a.downColor) },
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
 * Typeface of everything drawn on the chart canvas (axes, legends, price labels, drawings, positions): the same
 * stack as the UI's --font-sans in styles.css (a test keeps them equal), instead of KLineChart's Helvetica Neue,
 * so chart and chrome speak with one voice.
 */
export const CHART_FONT = "'Inter', 'InterVariable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Corner radius of chart labels (crosshair, last price, positions): the UI's --radius-sm. */
export const LABEL_RADIUS = 4;

/**
 * Color of the neutral last price line (the default): white on the dark theme, the theme's primary text color
 * (near-black) on the light one, where white would not show.
 */
export function neutralLastPriceColor(theme: ThemeName): string {
  return themeTokens(theme).lastPrice;
}

/** KLineChart's last price mark styles except the colors: a fine dashed line and a compact, semibold label. */
const lastPriceLine = () => ({ show: true, style: 'dashed' as const, dashedValue: [3, 3], size: 1 });
const LAST_PRICE_TEXT = {
  family: CHART_FONT, size: 12, weight: '600', borderRadius: LABEL_RADIUS,
  paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4,
} as const;

export interface LastPriceMarkStyles {
  upColor: string; downColor: string; noChangeColor: string;
  line: ReturnType<typeof lastPriceLine>;
  text: typeof LAST_PRICE_TEXT & { color: string };
}

/**
 * KLineChart's last price mark (line + y-axis label): one neutral color whatever the bar direction, or the candle
 * up / down (/ no-change) colors. The label text contrasts with the label fill (dark on the white label, white on
 * the near-black one); in 'candle' mode KLineChart draws the text in one color whatever the fill, so it is white
 * while its worst-case contrast over the three fills is about 3:1, else the better of white / dark.
 */
export function lastPriceMark(theme: ThemeName, mode: LastPriceLineStyle, up: string, down: string): LastPriceMarkStyles {
  if (mode === 'candle') {
    const muted = themeTokens(theme).muted;
    return { upColor: up, downColor: down, noChangeColor: muted, line: lastPriceLine(), text: { ...LAST_PRICE_TEXT, color: lastPriceTextColor(up, down, muted) } };
  }
  const c = neutralLastPriceColor(theme);
  return { upColor: c, downColor: c, noChangeColor: c, line: lastPriceLine(), text: { ...LAST_PRICE_TEXT, color: readableTextOn(c) } };
}

export function lastPriceTextColor(up: string, down: string, noChange: string): string {
  return readableTextOnAll([up, down, noChange]);
}

/**
 * Chart-wide styles of `theme` ("Graphite & Signal": the price is the only loud thing). Solid hairline grid (a dashed
 * grid shimmers while panning), no tick marks, small muted axis type in the UI typeface, a thin dashed crosshair with
 * compact borderless labels, hairline pane separators, opaque histogram bars in the exact candle colors.
 */
export function chartStyles(theme: ThemeName): DeepPartial<Styles> {
  const t = themeTokens(theme);
  const tickText = { color: t.muted, family: CHART_FONT, size: 11, weight: 'normal' };
  const axis = {
    axisLine: { show: true, color: t.border, size: 1 },
    tickLine: { show: false },
    tickText,
  };
  const crossText = {
    color: readableTextOn(t.crossBg), backgroundColor: t.crossBg, borderColor: t.crossBg, borderSize: 0, borderRadius: LABEL_RADIUS,
    family: CHART_FONT, size: 11, weight: '500', paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4,
  };
  const crossLine = () => ({ show: true, style: 'dashed' as const, dashedValue: [3, 3], size: 1, color: t.crosshair });
  const gridLine = { show: true, size: 1, style: 'solid', color: t.grid } as const;
  const legend = { family: CHART_FONT, size: 12, color: t.muted, marginLeft: 8, marginTop: 4, marginRight: 4, marginBottom: 4 };
  const priceExtreme = { color: t.muted, textFamily: CHART_FONT, textSize: 11 };
  return {
    grid: { show: true, horizontal: gridLine, vertical: gridLine },
    candle: {
      bar: {
        upColor: t.up, downColor: t.down, noChangeColor: t.muted,
        upBorderColor: t.up, downBorderColor: t.down, noChangeBorderColor: t.muted,
        upWickColor: t.up, downWickColor: t.down, noChangeWickColor: t.muted,
      },
      priceMark: {
        high: priceExtreme,
        low: priceExtreme,
        last: lastPriceMark(theme, defaultAppearance(theme).lastPriceLine, t.up, t.down),
      },
      tooltip: {
        title: { color: t.text, family: CHART_FONT, size: 13, weight: '600', template: '{displayName} · {tf}', marginLeft: 8, marginTop: 6, marginBottom: 2 },
        legend,
      },
    },
    indicator: {
      // Default histogram bars: filled, opaque, in the exact candle up / down colors (rising MACD / AO bars get the
      // soft tone, see solidBars.ts).
      bars: [{ style: 'fill', borderSize: 0, ...defaultIndicatorBars(theme) }],
      tooltip: { title: { color: t.text, family: CHART_FONT, size: 12, weight: '600' }, legend },
      lastValueMark: { show: false },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { size: 1, color: t.border, fill: true, activeBackgroundColor: hexToRgba(t.accent, 0.15) },
    crosshair: {
      horizontal: { line: crossLine(), text: crossText },
      vertical: { line: crossLine(), text: crossText },
    },
  };
}

import type { CandleBodyStyle, ChartAppearance, ChartType, DrawingLineStyle, LastPriceLineStyle, ThemedAppearance } from '@chartmate/shared';
import type { DeepPartial, Styles } from 'klinecharts';
import { contrastRatio, readableTextOn, readableTextOnAll } from './contrast';
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
    bg: '#0c0f18', panel: '#07090f', elevated: '#141826', border: '#1c202c', grid: '#121620', text: '#e9ecf4', muted: '#8f97ab', accent: '#7cc4ff',
    up: '#34e0b8', down: '#ff4d73', upSoft: '#00876d', downSoft: '#ac053e', upFg: '#34e0b8', downFg: '#ff7a8e',
    crossBg: '#e9ecf4', crosshair: '#5b6171', level: '#474e60', lastPrice: '#e9ecf4',
  },
  light: {
    bg: '#fafbfd', panel: '#e7eaf1', elevated: '#ffffff', border: '#e1e4eb', grid: '#eef0f4', text: '#131726', muted: '#545c6f', accent: '#2479d6',
    up: '#12b996', down: '#d92855', upSoft: '#67dbbb', downSoft: '#ff7d8e', upFg: '#006b56', downFg: '#b4003f',
    crossBg: '#131726', crosshair: '#a6abb8', level: '#b9bdc9', lastPrice: '#131726',
  },
} as const;

/*
 * "Luminous, flat": a cool ink ground (dark) / mist ground (light) with the chart on its own surface, chrome on flat
 * solid panels (no glass, glow or shadow), one sky accent for drawings and focus.
 *
 * Up / down (candles, volume / MACD / AO bars, position zones, watchlist and basket changes): Lumen teal and Ember
 * rose, vivid. Besides the hue they differ in LIGHTNESS so they stay apart for red-green color-blind readers: the up
 * color is the light one in both themes (OKLCH L dark 0.81 vs 0.68, light 0.70 vs 0.58). Small TEXT uses the --up-fg
 * / --down-fg CSS tokens instead (≥ 4.5:1 on every surface they are drawn on, including a tinted pill), hue-locked to
 * the strong color.
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
export const COLOR_DEFAULTS_REV = 3;

/**
 * Default colors of earlier revisions (rev 0: the original release; rev 1: an unreleased intermediate set; rev 2: the
 * "Graphite & Signal" set). A stored appearance / bar color exactly equal to one of them was (almost certainly) never
 * picked by the user — the dialogs write the shown defaults along with the edited field — so the one-time migration
 * unsets it.
 */
export const LEGACY_DEFAULTS = {
  dark: { up: ['#26a69a', '#34d399', '#00d68f'], down: ['#ef5350', '#f23c50', '#ff3b5c'], accent: ['#2962ff', '#3d6af5', '#2b66ff'] },
  light: { up: ['#089981', '#10a37a', '#00a870'], down: ['#f23645', '#c41d3d', '#d4113b'], accent: ['#2962ff', '#3d6af5', '#2b66ff'] },
} as const satisfies Record<ThemeName, Record<'up' | 'down' | 'accent', readonly string[]>>;

/**
 * Indicator line palettes of earlier revisions, per theme, by slot (rev 1 and rev 2; slots as in the catalog's
 * `lineSlots`). Before them (rev 0) line i took KLineChart's own palette by line index (LEGACY_KLINE_LINE_COLORS), VWAP
 * its own cyan. The settings dialog saved the whole `lineColors` list when one line changed, so an entry equal to its
 * line's old default was not picked by the user: the migration moves it to today's default (see
 * migrateLegacyLineColors in the catalog).
 */
export const LEGACY_INDICATOR_PALETTES: ReadonlyArray<{ theme: ThemeName; colors: readonly string[] }> = [
  { theme: 'dark', colors: ['#3987e5', '#d95926', '#1a9fb2', '#9085e9', '#c98500', '#d55181'] },
  { theme: 'light', colors: ['#2a78d6', '#eb6834', '#0097a7', '#4a3aa7', '#eda100', '#e87ba4'] },
  { theme: 'dark', colors: ['#2488f7', '#e56c19', '#00b3c2', '#8d7cf8', '#e49916', '#f631aa'] },
  { theme: 'light', colors: ['#1272da', '#eb6111', '#0095a0', '#541cdc', '#eda100', '#e12ca0'] },
];
/** Rev 0: KLineChart's default indicator line colors by line index, and the first VWAP color. */
export const LEGACY_KLINE_LINE_COLORS = ['#ff9600', '#935ebd', '#1677ff', '#e11d74', '#01c5c4'] as const;
export const LEGACY_VWAP_COLOR = '#01c5c4';

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
 * Categorical palette of indicator LINES, per theme (surfaces #0c0f18 / #fafbfd): halo gold, iris, cyan, orange, pink,
 * blue — vivid, deliberately without green / red so a line never reads as a candle up / down, and apart from the sky
 * drawing color. Slot n colors the n-th line of an indicator (see `lineSlots` in the catalog); the legend / tooltip
 * names every line. Histogram bars keep the candle up / down colors (`defaultIndicatorBars`).
 */
export const INDICATOR_PALETTE = {
  dark: ['#f2b861', '#a99bff', '#3fc8e4', '#ff8f5a', '#f27bd0', '#6f9dff'],
  light: ['#c98512', '#5b49e0', '#0a8ea6', '#e0621a', '#c8399a', '#2f62d6'],
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
export function candleStyles(type: ChartType, theme: ThemeName, appearance: ThemedAppearance | undefined, countdown = false): DeepPartial<Styles['candle']> {
  const a = resolveAppearance(theme, appearance);
  const muted = themeTokens(theme).muted;
  const colors: DeepPartial<Styles['candle']> = {
    bar: {
      upColor: a.upColor, downColor: a.downColor, noChangeColor: muted,
      upBorderColor: a.upColor, downBorderColor: a.downColor, noChangeBorderColor: muted,
      upWickColor: a.upColor, downWickColor: a.downColor, noChangeWickColor: muted,
    },
    priceMark: { last: lastPriceMark(theme, a.lastPriceLine, a.upColor, a.downColor, countdown) },
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
 * so chart and chrome speak with one voice. System fonts only (no web fonts: strict CSP, offline desktop app);
 * every stack ends in sans-serif.
 */
export const CHART_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Corner radius of chart labels (crosshair, last price, positions). */
export const LABEL_RADIUS = 6;

/**
 * Color of the neutral last price line (the default): the theme's primary text color (near-white on the dark theme,
 * ink on the light one).
 */
export function neutralLastPriceColor(theme: ThemeName): string {
  return themeTokens(theme).lastPrice;
}

/** KLineChart's last price mark styles except the colors: a fine dashed price line and a compact capsule label. */
const lastPriceLine = () => ({ show: true, style: 'dashed' as const, dashedValue: [2, 3], size: 1 });
const LAST_PRICE_TEXT = {
  family: CHART_FONT, size: 12, weight: '650', borderRadius: LABEL_RADIUS as number | number[],
  paddingLeft: 8, paddingRight: 8, paddingTop: 5, paddingBottom: 5,
};
/** The bar-close countdown under the price in the capsule (KLineChart extend text, refreshed every second). */
const COUNTDOWN_TEXT = {
  show: true, position: 'below_price' as const, updateInterval: 1000,
  family: CHART_FONT, size: 10, weight: '600', borderRadius: [0, 0, LABEL_RADIUS, LABEL_RADIUS] as number | number[],
  // KLineChart centers the price rect on the price and stacks this one below it; the text sits paddingTop into its
  // rect, so 0 here keeps the two lines tight while the price stays vertically centered on the price line.
  paddingLeft: 8, paddingRight: 8, paddingTop: 0, paddingBottom: 6,
};

export interface LastPriceMarkStyles {
  upColor: string; downColor: string; noChangeColor: string;
  line: ReturnType<typeof lastPriceLine>;
  text: typeof LAST_PRICE_TEXT & { color: string };
  extendTexts: Array<typeof COUNTDOWN_TEXT & { color: string }>;
}

/**
 * KLineChart's last price mark (price line + y-axis capsule): one neutral color whatever the bar direction (the
 * default), or the candle up / down colors. The capsule text contrasts with its fill; in 'candle' mode KLineChart
 * draws the text in one color whatever the fill, so it is chosen for the worst case over the fills (the no-change
 * fill is the neutral gray that reads best with it). `countdown`: the capsule carries the time
 * to the bar close under the price (the text comes from the adapter's formatExtendText).
 */
export function lastPriceMark(theme: ThemeName, mode: LastPriceLineStyle, up: string, down: string, countdown = false): LastPriceMarkStyles {
  let fills: { upColor: string; downColor: string; noChangeColor: string };
  let color: string;
  if (mode === 'candle') {
    const t = themeTokens(theme);
    // The neutral gray (muted or the crosshair gray) that leaves the label text most readable over all three fills.
    const worst = (n: string) => {
      const text = lastPriceTextColor(up, down, n);
      return Math.min(...[up, down, n].map((bg) => contrastRatio(text, bg)));
    };
    const noChange = worst(t.crosshair) > worst(t.muted) ? t.crosshair : t.muted;
    fills = { upColor: up, downColor: down, noChangeColor: noChange };
    color = lastPriceTextColor(up, down, noChange);
  } else {
    const c = neutralLastPriceColor(theme);
    fills = { upColor: c, downColor: c, noChangeColor: c };
    color = readableTextOn(c);
  }
  return {
    ...fills,
    line: lastPriceLine(),
    text: {
      ...LAST_PRICE_TEXT, color,
      borderRadius: countdown ? [LABEL_RADIUS, LABEL_RADIUS, 0, 0] : LABEL_RADIUS,
    },
    extendTexts: [{ ...COUNTDOWN_TEXT, show: countdown, color }],
  };
}

export function lastPriceTextColor(up: string, down: string, noChange: string): string {
  return readableTextOnAll([up, down, noChange]);
}

/**
 * Chart-wide styles of `theme` ("Luminous, flat": the price is the only loud thing). Solid hairline grid (a dashed
 * grid shimmers while panning), no tick marks, small muted axis type in the UI typeface, a thin dashed crosshair with
 * ink chips, hairline pane separators, an O / H / L / C legend, opaque histogram bars in the exact candle colors.
 */
export function chartStyles(theme: ThemeName): DeepPartial<Styles> {
  const t = themeTokens(theme);
  const tickText = { color: t.muted, family: CHART_FONT, size: 11, weight: '500' };
  const axis = {
    axisLine: { show: true, color: t.border, size: 1 },
    tickLine: { show: false },
    tickText,
  };
  const crossText = {
    color: readableTextOn(t.crossBg), backgroundColor: t.crossBg, borderColor: t.crossBg, borderSize: 0, borderRadius: LABEL_RADIUS,
    family: CHART_FONT, size: 11, weight: '600', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
  };
  const crossLine = () => ({ show: true, style: 'dashed' as const, dashedValue: [3, 3], size: 1, color: t.crosshair });
  const gridLine = { show: true, size: 1, style: 'solid', color: t.grid } as const;
  const legend = { family: CHART_FONT, size: 12, color: t.muted, marginLeft: 10, marginTop: 4, marginRight: 2, marginBottom: 4 };
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
        title: { color: t.text, family: CHART_FONT, size: 15, weight: '650', template: '{displayName} · {tf}', marginLeft: 10, marginTop: 8, marginBottom: 2 },
        legend: { ...legend, template: candleLegend(t) },
      },
    },
    indicator: {
      // Default histogram bars: filled, opaque, in the exact candle up / down colors (rising MACD / AO bars get the
      // soft tone, see solidBars.ts).
      bars: [{ style: 'fill', borderSize: 0, ...defaultIndicatorBars(theme) }],
      tooltip: { title: { color: t.text, family: CHART_FONT, size: 12, weight: '600', marginLeft: 10 }, legend },
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

type LegendItem = { title: { text: string; color: string }; value: { text: string; color: string } };
type LegendBar = { open: number; close: number };

/**
 * The candle legend: "O 172.28  H 172.91  L 169.51  C 170.64  −0.96%  Vol 43.31M" — muted letters, values in the text
 * color, the change vs the previous close in the theme's up / down TEXT colors (readable as small text).
 */
export function candleLegend(t: ThemeTokens): (data: { prev: LegendBar | null; current: LegendBar | null }) => LegendItem[] {
  return ({ prev, current }) => {
    const item = (title: string, value: string, color: string = t.text): LegendItem => ({ title: { text: title, color: t.muted }, value: { text: value, color } });
    const out = [item('O ', '{open}'), item('H ', '{high}'), item('L ', '{low}'), item('C ', '{close}')];
    const base = prev?.close ?? current?.open;
    if (current && base) {
      const pct = Math.round(((current.close - base) / base) * 10_000) / 100;
      const text = pct === 0 ? '0.00%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
      out.push(item('', text, pct > 0 ? t.upFg : pct < 0 ? t.downFg : t.muted));
    }
    out.push(item('Vol ', '{volume}'));
    return out;
  };
}

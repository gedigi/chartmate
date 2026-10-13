import type { CandleBodyStyle, ChartAppearance, ChartType, DrawingLineStyle, ThemedAppearance } from '@altv/shared';
import type { DeepPartial, Styles } from 'klinecharts';
import { readableTextOn, readableTextOnAll } from './contrast';
import { klineLine } from './drawingStyles';

export type ThemeName = 'dark' | 'light';

/**
 * Fallback chart tokens. The ones with a CSS custom property (THEME_CSS_VARS) are read from src/styles.css at
 * runtime (refreshThemeTokens); these constants are only used when that is not possible, and a parity test
 * keeps them equal to styles.css. `grid` and `crossBg` are chart-only.
 */
export const THEME_TOKENS = {
  dark: {
    bg: '#131722', panel: '#1e222d', elevated: '#2a2e39', border: '#363a45', grid: '#1f2330', text: '#d1d4dc', muted: '#868b98', accent: '#2962ff',
    up: '#26a69a', down: '#ef5350', crossBg: '#363a45',
  },
  light: {
    bg: '#ffffff', panel: '#f8f9fd', elevated: '#ffffff', border: '#e0e3eb', grid: '#f0f3fa', text: '#131722', muted: '#6a6d78', accent: '#2962ff',
    up: '#089981', down: '#f23645', crossBg: '#131722',
  },
} as const;

type ThemeTokens = { -readonly [K in keyof typeof THEME_TOKENS.dark]: string };

/** Chart token → CSS custom property in styles.css. */
export const THEME_CSS_VARS: Readonly<Partial<Record<keyof ThemeTokens, string>>> = {
  bg: '--bg', panel: '--bg-panel', elevated: '--bg-elevated', border: '--border', text: '--text', muted: '--text-muted', accent: '--accent',
  up: '--up', down: '--down',
};

const live: Partial<Record<ThemeName, ThemeTokens>> = {};

/** The chart tokens of `theme`: the last values read from the CSS (refreshThemeTokens), else the constants. */
export function themeTokens(theme: ThemeName): ThemeTokens {
  return live[theme] ?? THEME_TOKENS[theme];
}

const isHexColour = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

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
    if (isHexColour(v)) next[key] = v.toLowerCase();
  }
  live[theme] = next;
}

/** Every appearance field resolved (unset fields follow the theme). */
export interface ResolvedAppearance {
  upColor: string; downColor: string; candleBody: CandleBodyStyle; lineColor: string; lineWidth: number; drawing: DrawingLineStyle;
}

/**
 * Default up / down colours of indicator histograms (VOL, MACD, AO): the theme's up / down colours. Per-indicator
 * `barColors` overrides still win.
 */
export function defaultBarColors(theme: ThemeName): { up: string; down: string } {
  const { up, down } = themeTokens(theme);
  return { up, down };
}

/** Chart default histogram bar colours: the theme's up / down, as translucent as KLineChart's own defaults. */
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
    // Annotation bubbles are filled with the drawing colour: the glyphs take whichever of white / dark reads on it.
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
  const colours: DeepPartial<Styles['candle']> = {
    bar: {
      upColor: a.upColor, downColor: a.downColor, noChangeColor: muted,
      upBorderColor: a.upColor, downBorderColor: a.downColor, noChangeBorderColor: muted,
      upWickColor: a.upColor, downWickColor: a.downColor, noChangeWickColor: muted,
    },
    priceMark: { last: { upColor: a.upColor, downColor: a.downColor, noChangeColor: muted, text: { color: lastPriceTextColour(a.upColor, a.downColor, muted) } } },
  };
  switch (type) {
    case 'candle': return { ...colours, type: BODY_TYPE[a.candleBody] };
    case 'ohlc': return { ...colours, type: 'ohlc' };
    case 'line':
    case 'area': {
      const fill = type === 'line'
        ? [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0)' }]
        : [{ offset: 0, color: hexToRgba(a.lineColor, 0.02) }, { offset: 1, color: hexToRgba(a.lineColor, 0.28) }];
      return { ...colours, type: 'area', area: { lineColor: a.lineColor, lineSize: a.lineWidth, backgroundColor: fill } };
    }
  }
}

/**
 * KLineChart fills the last-price label with the up / down / no-change colour but draws its text in a single
 * colour, so the text cannot follow the bar direction: white while its worst-case contrast over the three
 * label colours is at least 3:1, else whichever of white / dark has the higher worst case.
 */
export function lastPriceTextColour(up: string, down: string, noChange: string): string {
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
        last: { upColor: t.up, downColor: t.down, noChangeColor: t.muted, text: { color: lastPriceTextColour(t.up, t.down, t.muted) } },
      },
      tooltip: { title: { color: t.text, template: '{displayName} · {tf}' }, legend: { color: t.muted } },
    },
    indicator: {
      // Default histogram bars: the theme's up / down colours, as translucent as KLineChart's own defaults.
      bars: [defaultIndicatorBars(theme)],
      tooltip: { title: { color: t.text }, legend: { color: t.muted } },
      lastValueMark: { show: false },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: t.border, activeBackgroundColor: 'rgba(41,98,255,0.15)' },
    crosshair: {
      horizontal: { line: { color: t.muted }, text: crossText },
      vertical: { line: { color: t.muted }, text: crossText },
    },
  };
}

import type { CandleBodyStyle, ChartAppearance, ChartType, DrawingLineStyle } from '@altv/shared';
import type { DeepPartial, Styles } from 'klinecharts';

export type ThemeName = 'dark' | 'light';

/** Mirrors the CSS tokens in src/styles.css (canvas cannot read CSS variables cheaply). */
export const THEME_TOKENS = {
  dark: { bg: '#131722', panel: '#1e222d', elevated: '#2a2e39', border: '#363a45', grid: '#1f2330', text: '#d1d4dc', muted: '#868b98', accent: '#2962ff', crossBg: '#363a45' },
  light: { bg: '#ffffff', panel: '#f8f9fd', elevated: '#ffffff', border: '#e0e3eb', grid: '#f0f3fa', text: '#131722', muted: '#6a6d78', accent: '#2962ff', crossBg: '#131722' },
} as const;

export const UP = '#26a69a';
export const DOWN = '#ef5350';

/** Every appearance field resolved (unset fields follow the theme). */
export interface ResolvedAppearance {
  upColor: string; downColor: string; candleBody: CandleBodyStyle; lineColor: string; lineWidth: number; drawing: DrawingLineStyle;
}

export function defaultAppearance(theme: ThemeName): ResolvedAppearance {
  const accent = THEME_TOKENS[theme].accent;
  return { upColor: UP, downColor: DOWN, candleBody: 'solid', lineColor: accent, lineWidth: 2, drawing: { color: accent, size: 1, style: 'solid' } };
}

export function resolveAppearance(theme: ThemeName, a: ChartAppearance | undefined): ResolvedAppearance {
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

/** Candle-series styles for a chart type with the (theme-resolved) appearance applied. */
export function candleStyles(type: ChartType, theme: ThemeName, appearance: ChartAppearance | undefined): DeepPartial<Styles['candle']> {
  const a = resolveAppearance(theme, appearance);
  const muted = THEME_TOKENS[theme].muted;
  const colours: DeepPartial<Styles['candle']> = {
    bar: {
      upColor: a.upColor, downColor: a.downColor, noChangeColor: muted,
      upBorderColor: a.upColor, downBorderColor: a.downColor, noChangeBorderColor: muted,
      upWickColor: a.upColor, downWickColor: a.downColor, noChangeWickColor: muted,
    },
    priceMark: { last: { upColor: a.upColor, downColor: a.downColor, noChangeColor: muted } },
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

export function chartStyles(theme: ThemeName): DeepPartial<Styles> {
  const t = THEME_TOKENS[theme];
  const axis = {
    axisLine: { color: t.border },
    tickLine: { color: t.border },
    tickText: { color: t.muted },
  };
  const crossText = { color: '#ffffff', backgroundColor: t.crossBg, borderColor: t.border };
  return {
    grid: {
      horizontal: { color: t.grid },
      vertical: { color: t.grid },
    },
    candle: {
      bar: {
        upColor: UP, downColor: DOWN, noChangeColor: t.muted,
        upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: t.muted,
        upWickColor: UP, downWickColor: DOWN, noChangeWickColor: t.muted,
      },
      priceMark: {
        high: { color: t.muted },
        low: { color: t.muted },
        last: { upColor: UP, downColor: DOWN, noChangeColor: t.muted },
      },
      tooltip: { title: { color: t.text, template: '{displayName} · {tf}' }, legend: { color: t.muted } },
    },
    indicator: {
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

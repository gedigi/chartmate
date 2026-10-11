import type { DeepPartial, Styles } from 'klinecharts';

export type ThemeName = 'dark' | 'light';

/** Mirrors the CSS tokens in src/styles.css (canvas cannot read CSS variables cheaply). */
export const THEME_TOKENS = {
  dark: { bg: '#131722', panel: '#1e222d', elevated: '#2a2e39', border: '#363a45', grid: '#1f2330', text: '#d1d4dc', muted: '#868b98', accent: '#2962ff', crossBg: '#363a45' },
  light: { bg: '#ffffff', panel: '#f8f9fd', elevated: '#ffffff', border: '#e0e3eb', grid: '#f0f3fa', text: '#131722', muted: '#6a6d78', accent: '#2962ff', crossBg: '#131722' },
} as const;

export const UP = '#26a69a';
export const DOWN = '#ef5350';

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

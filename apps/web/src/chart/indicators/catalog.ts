import { indicatorPaletteColor, type ThemeName } from '../theme';
import { CUSTOM_INDICATORS } from './extensions';
import type { CatalogEntry } from './types';

export type { CatalogEntry } from './types';

const periods = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1} period`);
const numbered = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * KLineChart built-ins we expose. `lines` follow each template's line-figure order.
 * Default line colours: line i uses palette slot i (INDICATOR_PALETTE), except BOLL (Upper/Middle/Lower = slots
 * 2/1/3, so the middle band matches MA's first line) and VWAP (slot 3, see custom/vwap.ts). Max 4 lines today.
 * Note: KLineChart's `MA` is the simple moving average; its `SMA` is a different, weighted average.
 */
const BUILTIN: CatalogEntry[] = [
  // overlays (candle pane)
  { name: 'MA', label: 'Moving Average (SMA)', pane: 'main', defaultParams: [5, 10, 30, 60], paramLabels: periods('MA', 4), lines: numbered('MA', 4) },
  { name: 'EMA', label: 'Exponential MA', pane: 'main', defaultParams: [6, 12, 20], paramLabels: periods('EMA', 3), lines: numbered('EMA', 3) },
  { name: 'BOLL', label: 'Bollinger Bands', pane: 'main', defaultParams: [20, 2], paramLabels: ['Period', 'Std dev'], lines: ['Upper', 'Middle', 'Lower'], lineSlots: [1, 0, 2], decimalParams: [1] },
  // SAR params are percentages (KLineChart divides by 100); it draws circles, so there are no line colours.
  { name: 'SAR', label: 'Parabolic SAR', pane: 'main', defaultParams: [2, 2, 20], paramLabels: ['Start AF (%)', 'Step (%)', 'Max AF (%)'], lines: [], decimalParams: [0, 1, 2] },
  { name: 'BBI', label: 'Bull and Bear Index', pane: 'main', defaultParams: [3, 6, 12, 24], paramLabels: periods('MA', 4), lines: ['BBI'] },
  // oscillators (own pane)
  { name: 'VOL', label: 'Volume', pane: 'sub', defaultParams: [5, 10, 20], paramLabels: periods('MA', 3), lines: numbered('MA', 3), bars: true },
  { name: 'MACD', label: 'MACD', pane: 'sub', defaultParams: [12, 26, 9], paramLabels: ['Fast period', 'Slow period', 'Signal period'], lines: ['DIF', 'DEA'], bars: true },
  { name: 'RSI', label: 'Relative Strength Index', pane: 'sub', defaultParams: [6, 12, 24], paramLabels: periods('RSI', 3), lines: numbered('RSI', 3) },
  { name: 'KDJ', label: 'Stochastic (KDJ)', pane: 'sub', defaultParams: [9, 3, 3], paramLabels: ['Period', 'K smoothing', 'D smoothing'], lines: ['K', 'D', 'J'] },
  { name: 'CCI', label: 'Commodity Channel Index', pane: 'sub', defaultParams: [13], paramLabels: ['Period'], lines: ['CCI'] },
  { name: 'OBV', label: 'On-Balance Volume', pane: 'sub', defaultParams: [30], paramLabels: ['MA period'], lines: ['OBV', 'MAOBV'] },
  { name: 'WR', label: 'Williams %R', pane: 'sub', defaultParams: [6, 10, 14], paramLabels: periods('WR', 3), lines: numbered('WR', 3) },
  { name: 'DMI', label: 'Directional Movement Index', pane: 'sub', defaultParams: [14, 6], paramLabels: ['DI period', 'ADX period'], lines: ['PDI', 'MDI', 'ADX', 'ADXR'] },
  { name: 'ROC', label: 'Rate of Change', pane: 'sub', defaultParams: [12, 6], paramLabels: ['Period', 'MA period'], lines: ['ROC', 'MAROC'] },
  { name: 'MTM', label: 'Momentum', pane: 'sub', defaultParams: [12, 6], paramLabels: ['Period', 'MA period'], lines: ['MTM', 'MAMTM'] },
  { name: 'TRIX', label: 'TRIX', pane: 'sub', defaultParams: [12, 9], paramLabels: ['Period', 'MA period'], lines: ['TRIX', 'MATRIX'] },
  { name: 'AO', label: 'Awesome Oscillator', pane: 'sub', defaultParams: [5, 34], paramLabels: ['Short period', 'Long period'], lines: [], bars: true },
  { name: 'SMA', label: 'SMA (weighted, KLine)', pane: 'sub', defaultParams: [12, 2], paramLabels: ['Period', 'Weight'], lines: ['SMA'] },
];

/** Picker order; custom indicators not listed here go after the built-ins of their pane. */
const ORDER = ['MA', 'EMA', 'BOLL', 'SAR', 'VWAP', 'BBI', 'VOL', 'MACD', 'RSI', 'KDJ', 'CCI', 'ATR', 'OBV', 'WR', 'DMI', 'ROC', 'MTM', 'TRIX', 'AO', 'SMA'];

function buildCatalog(): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry>(BUILTIN.map((e) => [e.name, e]));
  // A custom indicator with a built-in's name overrides it (its template replaces KLineChart's too).
  for (const c of CUSTOM_INDICATORS) {
    const bars = c.catalog.bars ?? (c.template.figures ?? []).some((f) => f.type === 'bar');
    byName.set(c.catalog.name, bars ? { ...c.catalog, bars } : c.catalog);
  }
  const rank = (n: string) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
  return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name));
}

export const CATALOG: readonly CatalogEntry[] = buildCatalog();

export function catalogEntry(name: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.name === name);
}

/**
 * Default colour of line `i` of indicator `name` in `theme`: the palette slot from the catalog's `lineSlots`
 * (default: slot i). Unknown indicators use slot i.
 */
export function defaultLineColor(i: number, name: string | undefined, theme: ThemeName): string {
  const slot = (name === undefined ? undefined : catalogEntry(name)?.lineSlots?.[i]) ?? i;
  return indicatorPaletteColor(theme, slot);
}

/** Default colours of all lines of indicator `name` in `theme`, in line order. */
export function defaultLineColors(name: string, theme: ThemeName): string[] {
  return (catalogEntry(name)?.lines ?? []).map((_, i) => defaultLineColor(i, name, theme));
}

/**
 * Stored-params migration: older layouts may hold fewer params than the catalog now defines (e.g. a param
 * added later). Missing trailing params get the catalog defaults; extra ones are dropped. Unknown indicators
 * keep their stored params.
 */
export function migrateCalcParams(name: string, stored: readonly number[]): number[] {
  const entry = catalogEntry(name);
  if (!entry) return [...stored];
  return entry.defaultParams.map((d, i) => stored[i] ?? d);
}

/** Short chip label: `RSI(6, 12, 24)`, or just the name when there are no params. */
export function indicatorLabel(s: { name: string; calcParams: readonly number[] }): string {
  return s.calcParams.length > 0 ? `${s.name}(${s.calcParams.join(', ')})` : s.name;
}

/** Largest accepted integer (period) param. */
export const MAX_PERIOD = 1000;

/** Validates the raw text of param `index` of indicator `name`; returns an error message or null. */
export function validateParam(name: string, index: number, raw: string): string | null {
  const text = raw.trim();
  if (text === '') return 'Required';
  const v = Number(text);
  if (!Number.isFinite(v)) return 'Must be a number';
  const entry = catalogEntry(name);
  if (entry?.decimalParams?.includes(index)) return v > 0 ? null : 'Must be greater than 0';
  const min = entry?.paramMin?.[index] ?? 1;
  const max = entry?.paramMax?.[index] ?? MAX_PERIOD;
  if (!Number.isInteger(v) || v < min) return `Must be a whole number ≥ ${min}`;
  return v <= max ? null : `Must be at most ${max}`;
}

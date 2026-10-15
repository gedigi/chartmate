import {
  INDICATOR_PALETTE, indicatorPaletteColor, LEGACY_INDICATOR_PALETTES, LEGACY_KLINE_LINE_COLORS, LEGACY_LINE_SLOTS, LEGACY_VWAP_COLOR, type ThemeName,
} from '../theme';
import { CUSTOM_INDICATORS } from './extensions';
import type { CatalogEntry } from './types';

export type { CatalogEntry } from './types';

const periods = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1} period`);
const numbered = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * KLineChart built-ins we expose. `lines` follow each template's line-figure order.
 * Default line colors: line i uses palette slot i (INDICATOR_PALETTE, 0-based), except BOLL (Upper/Middle/Lower = slots
 * 1/0/2, so the middle band matches MA's first line) and VWAP (slot 5, see custom/vwap.ts). Max 4 lines today.
 * Note: KLineChart's `MA` is the simple moving average; its `SMA` is a different, weighted average.
 * `levels`: conventional reference lines of oscillators: zero lines of MACD / AO / ROC / MTM /
 * TRIX, overbought / oversold bands of RSI (70 / 30), KDJ (80 / 20), CCI (+-100) and WR (-20 / -80; KLineChart's WR
 * runs from -100 to 0), and DMI's ADX trend threshold 25. VOL, OBV (cumulative), SMA and ATR have none.
 */
const BUILTIN: CatalogEntry[] = [
  // overlays (candle pane)
  { name: 'MA', label: 'Moving average (SMA)', pane: 'main', defaultParams: [5, 10, 30, 60], paramLabels: periods('MA', 4), lines: numbered('MA', 4) },
  { name: 'EMA', label: 'Exponential moving average', pane: 'main', defaultParams: [6, 12, 20], paramLabels: periods('EMA', 3), lines: numbered('EMA', 3) },
  { name: 'BOLL', label: 'Bollinger Bands', pane: 'main', defaultParams: [20, 2], paramLabels: ['Period', 'Std dev'], lines: ['Upper', 'Middle', 'Lower'], lineSlots: [1, 0, 2], decimalParams: [1] },
  // SAR params are percentages (KLineChart divides by 100); it draws circles, so there are no line colors.
  { name: 'SAR', label: 'Parabolic SAR', pane: 'main', defaultParams: [2, 2, 20], paramLabels: ['Start AF (%)', 'Step (%)', 'Max AF (%)'], lines: [], decimalParams: [0, 1, 2] },
  { name: 'BBI', label: 'Bull and bear index', pane: 'main', defaultParams: [3, 6, 12, 24], paramLabels: periods('MA', 4), lines: ['BBI'] },
  // oscillators (own pane)
  { name: 'VOL', label: 'Volume', pane: 'sub', defaultParams: [5, 10, 20], paramLabels: periods('MA', 3), lines: numbered('MA', 3), bars: true },
  { name: 'MACD', label: 'MACD', pane: 'sub', defaultParams: [12, 26, 9], paramLabels: ['Fast period', 'Slow period', 'Signal period'], lines: ['DIF', 'DEA'], bars: true, levels: [0] },
  { name: 'RSI', label: 'Relative strength index', pane: 'sub', defaultParams: [6, 12, 24], paramLabels: periods('RSI', 3), lines: numbered('RSI', 3), levels: [70, 30] },
  { name: 'KDJ', label: 'Stochastic (KDJ)', pane: 'sub', defaultParams: [9, 3, 3], paramLabels: ['Period', 'K smoothing', 'D smoothing'], lines: ['K', 'D', 'J'], levels: [80, 20] },
  { name: 'CCI', label: 'Commodity channel index', pane: 'sub', defaultParams: [13], paramLabels: ['Period'], lines: ['CCI'], levels: [100, -100] },
  { name: 'OBV', label: 'On-balance volume', pane: 'sub', defaultParams: [30], paramLabels: ['MA period'], lines: ['OBV', 'MAOBV'] },
  { name: 'WR', label: 'Williams %R', pane: 'sub', defaultParams: [6, 10, 14], paramLabels: periods('WR', 3), lines: numbered('WR', 3), levels: [-20, -80] },
  { name: 'DMI', label: 'Directional movement index', pane: 'sub', defaultParams: [14, 6], paramLabels: ['DI period', 'ADX period'], lines: ['PDI', 'MDI', 'ADX', 'ADXR'], levels: [25] },
  { name: 'ROC', label: 'Rate of change', pane: 'sub', defaultParams: [12, 6], paramLabels: ['Period', 'MA period'], lines: ['ROC', 'MAROC'], levels: [0] },
  { name: 'MTM', label: 'Momentum', pane: 'sub', defaultParams: [12, 6], paramLabels: ['Period', 'MA period'], lines: ['MTM', 'MAMTM'], levels: [0] },
  { name: 'TRIX', label: 'TRIX', pane: 'sub', defaultParams: [12, 9], paramLabels: ['Period', 'MA period'], lines: ['TRIX', 'MATRIX'], levels: [0] },
  { name: 'AO', label: 'Awesome oscillator', pane: 'sub', defaultParams: [5, 34], paramLabels: ['Short period', 'Long period'], lines: [], bars: true, levels: [0] },
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
 * Default color of line `i` of indicator `name` in `theme`: the palette slot from the catalog's `lineSlots`
 * (default: slot i). Unknown indicators use slot i.
 */
export function defaultLineColor(i: number, name: string | undefined, theme: ThemeName): string {
  const slot = (name === undefined ? undefined : catalogEntry(name)?.lineSlots?.[i]) ?? i;
  return indicatorPaletteColor(theme, slot);
}

/**
 * The user's own color for line `i` of indicator `name`, or undefined when that line follows the theme palette.
 * `lineColors` is sparse: an empty entry (or a missing one) is the theme default. An entry equal to that line's
 * default in EITHER theme is read as a default too: older versions saved the whole list when one line changed,
 * freezing the untouched lines to the palette of the theme they were edited in.
 * Known trade-off: a color the user picks that equals this line's default in the OTHER theme is read as a default
 * too (it follows the theme). Old dense payloads cannot be told apart from such a pick, and the case is rare.
 */
export function lineColorOverride(name: string, i: number, stored: string | undefined): string | undefined {
  if (!stored) return undefined;
  const c = stored.toLowerCase();
  return c === defaultLineColor(i, name, 'dark') || c === defaultLineColor(i, name, 'light') ? undefined : stored;
}

/** The color drawn for line `i` of indicator state `s` in `theme`: its override, else the theme default. */
export function effectiveLineColor(s: { name: string; lineColors?: readonly string[] }, i: number, theme: ThemeName): string {
  return lineColorOverride(s.name, i, s.lineColors?.[i]) ?? defaultLineColor(i, s.name, theme);
}

/**
 * Sparse `lineColors` to store for the edited `colors` (one per line): '' for every line left at a default, trailing
 * defaults trimmed; undefined when no line has a color of its own.
 */
export function sparseLineColors(name: string, colors: readonly string[]): string[] | undefined {
  const out = colors.map((c, i) => lineColorOverride(name, i, c) ?? '');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length > 0 ? out : undefined;
}

/** Default colors of all lines of indicator `name` in `theme`, in line order. */
export function defaultLineColors(name: string, theme: ThemeName): string[] {
  return (catalogEntry(name)?.lines ?? []).map((_, i) => defaultLineColor(i, name, theme));
}

/**
 * Stored line colors of indicator `name` with earlier default palettes resolved, per line: an entry equal to ITS
 * line's old default (any earlier palette generation, either theme, at the slot the line had then — LEGACY_LINE_SLOTS;
 * rev 0: KLineChart's colors by line index) becomes
 * today's default for that line in the theme of the palette it came from (rev 0 was the dark-first release); any
 * other entry — including an old palette color on another line, i.e. a swapped / reordered palette — is the user's
 * pick and is kept. Undefined when every entry ends up a default (the lines then follow the active theme).
 */
export function migrateLegacyLineColors(name: string, colors: readonly string[]): string[] | undefined {
  let custom = false;
  const out = colors.map((raw, i) => {
    const c = raw.toLowerCase();
    // The slot(s) this line had in the earlier generations: its current slot, unless it moved (LEGACY_LINE_SLOTS);
    // a moved line's old slot is matched in today's palette too (its default until the move).
    const moved = LEGACY_LINE_SLOTS[name]?.[i];
    const slots = moved ?? [catalogEntry(name)?.lineSlots?.[i] ?? i];
    const generations = moved
      ? [...LEGACY_INDICATOR_PALETTES, ...(['dark', 'light'] as const).map((theme) => ({ theme, colors: INDICATOR_PALETTE[theme] }))]
      : LEGACY_INDICATOR_PALETTES;
    const generation = generations.find((p) => slots.some((s) => p.colors[s] === c));
    if (generation) return defaultLineColor(i, name, generation.theme);
    const rev0 = name === 'VWAP' && i === 0 ? LEGACY_VWAP_COLOR : LEGACY_KLINE_LINE_COLORS[i % LEGACY_KLINE_LINE_COLORS.length];
    if (c === rev0) return defaultLineColor(i, name, 'dark');
    custom = true;
    return raw;
  });
  return custom ? out : undefined;
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

/**
 * Reference levels drawn for indicator state `s`: none when hidden (`showLevels: false`) or the indicator has no
 * catalog levels; else the stored levels, or the catalog defaults when none are stored (older layouts).
 */
export function effectiveLevels(s: { name: string; levels?: readonly number[]; showLevels?: boolean }): number[] {
  const defaults = catalogEntry(s.name)?.levels;
  if (!defaults || s.showLevels === false) return [];
  return [...(s.levels ?? defaults)];
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

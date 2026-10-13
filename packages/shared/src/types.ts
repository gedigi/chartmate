export type Timeframe = '1m'|'5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'1D'|'1W'|'1M';
export type Session = 'pre'|'regular'|'post';
export type SessionMode = 'rth'|'eth';
export type AssetClass = 'stock'|'crypto'|'basket';
export type SymbolId = string; // 'stock:AAPL' | 'crypto:BTC' | 'basket:<uuid>'
export interface Bar {
  ts: number; open: number; high: number; low: number; close: number; volume: number; session?: Session;
  /** Basket bars before the basket's start: version 0's holdings applied to earlier prices. */
  simulated?: boolean;
}
export interface SymbolInfo { id: SymbolId; assetClass: AssetClass; ticker: string; name: string; exchange?: string; pricePrecision: number }
/** Extended-hours price: `changePct` is vs the latest REGULAR close (the quote's own `price`). */
export interface QuoteExt { session: 'pre' | 'post'; price: number; changePct: number; ts: number }
/**
 * `price`/`changePct`/`ts` are always the REGULAR session pair: the last regular price and its day change vs the
 * previous regular close. `ext` is set only while a stock trades pre/post-market (never for crypto).
 */
export interface Quote { id: SymbolId; price: number; changePct: number | null; ts: number; ext?: QuoteExt }
export interface BasketVersion { effectiveFrom: string /* 'YYYY-MM-DD' */; weights: Record<SymbolId, number> }
export interface Basket { id: string; name: string; baseValue: number; versions: BasketVersion[]; createdAt: number; updatedAt: number }
export interface Marker { ts: number; label: string }
export interface BarsResponse { symbol: SymbolId; tf: Timeframe; session: SessionMode; bars: Bar[]; hasMoreBefore: boolean; stale: boolean; notices: string[]; markers: Marker[] }
export interface LatestResponse { bar: Bar | null; stale: boolean }
export type LineStyleKind = 'solid'|'dashed'|'dotted';
export interface IndicatorState {
  name: string; pane: 'main'|'sub'; calcParams: number[]; visible: boolean;
  lineColors?: string[];
  /** Per line width in px (1–4); default 1. */
  lineWidths?: number[];
  /** Per line style; default solid. */
  lineStyles?: LineStyleKind[];
  /** Histogram (bar figure) colours; default KLineChart's green/red. */
  barColors?: { up: string; down: string };
}
export type ChartType = 'candle'|'ohlc'|'line'|'area';
/** Most indicators a layout may hold (enforced by the server's layout schema and the indicator picker). */
export const MAX_INDICATORS = 30;
/** Candle body style (chart type 'candle'): filled, hollow, hollow up candles only, hollow down candles only. */
export type CandleBodyStyle = 'solid'|'hollow'|'hollow_up'|'hollow_down';
export interface DrawingLineStyle { color: string; size: number; style: LineStyleKind }
/**
 * Chart appearance of one theme. Every field is optional: unset fields follow the theme's defaults.
 */
export interface ChartAppearance {
  upColor?: string;
  downColor?: string;
  candleBody?: CandleBodyStyle;
  /** Line / area chart line colour and width (1–4). */
  lineColor?: string;
  lineWidth?: number;
  /** Style of new drawings. */
  drawing?: DrawingLineStyle;
}
export type AppearanceTheme = 'dark' | 'light';
/**
 * Global chart appearance, one set per theme (stored in the 'default' layout only): colours that read well on
 * the dark background rarely do on the light one, so each theme keeps its own settings.
 */
export interface ThemedAppearance { dark?: ChartAppearance; light?: ChartAppearance }
export interface Layout {
  symbol: SymbolId; tf: Timeframe; session: SessionMode; chartType: ChartType; indicators: IndicatorState[];
  appearance?: ThemedAppearance;
  /** Risk settings new long / short positions start with (missing → DEFAULT_POSITION_SETTINGS). */
  positionDefaults?: PositionDefaults;
}

/** Long / short position drawing tools. */
export const POSITION_TOOLS = ['longPosition', 'shortPosition'] as const;
export type PositionTool = typeof POSITION_TOOLS[number];
export const isPositionTool = (name: string): name is PositionTool => (POSITION_TOOLS as readonly string[]).includes(name);
/** How a position's risk is given: a percentage of the account size or a fixed amount. */
export type PositionRiskMode = 'percent' | 'amount';
/** Risk settings of a long / short position (every field optional: unset → the defaults). */
export interface PositionSettings { accountSize?: number; riskMode?: PositionRiskMode; riskValue?: number; currency?: string }
export type PositionDefaults = Required<PositionSettings>;
export const DEFAULT_POSITION_SETTINGS: Readonly<PositionDefaults> = { accountSize: 10000, riskMode: 'percent', riskValue: 1, currency: 'USD' };
/** Longest account currency label. */
export const MAX_CURRENCY_LENGTH = 8;
/** Largest account size / risk amount (the server enforces the same limits). */
export const MAX_POSITION_AMOUNT = 1e15;
/** Largest risk in 'percent' mode. */
export const MAX_RISK_PERCENT = 100;

const positiveFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_POSITION_AMOUNT;

/**
 * The valid position settings in `s`, or undefined: positive finite numbers up to MAX_POSITION_AMOUNT, a known risk
 * mode, a 1–8 character currency; a risk value over 100 is dropped when the mode in `s` is 'percent'.
 */
export function sanitizePositionSettings(s: unknown): PositionSettings | undefined {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const { accountSize, riskMode, riskValue, currency } = s as Record<string, unknown>;
  const out: PositionSettings = {};
  if (positiveFinite(accountSize)) out.accountSize = accountSize;
  if (riskMode === 'percent' || riskMode === 'amount') out.riskMode = riskMode;
  if (positiveFinite(riskValue) && !(out.riskMode === 'percent' && riskValue > MAX_RISK_PERCENT)) out.riskValue = riskValue;
  if (typeof currency === 'string') {
    const c = currency.trim();
    if (c.length > 0 && c.length <= MAX_CURRENCY_LENGTH) out.currency = c;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Settings over defaults, with a percentage risk capped at 100 (e.g. an own amount over percent defaults). */
export function mergePositionSettings(base: PositionDefaults, own: PositionSettings | undefined): PositionDefaults {
  const out = { ...base, ...sanitizePositionSettings(own) };
  if (out.riskMode === 'percent' && out.riskValue > MAX_RISK_PERCENT) out.riskValue = MAX_RISK_PERCENT;
  return out;
}

/** Stored position defaults with missing / invalid fields filled from DEFAULT_POSITION_SETTINGS. */
export function resolvePositionDefaults(d: PositionSettings | undefined): PositionDefaults {
  return mergePositionSettings({ ...DEFAULT_POSITION_SETTINGS }, d);
}

/** True when every field of `d` is within the limits the server accepts for layout position defaults. */
export function isValidPositionDefaults(d: PositionDefaults): boolean {
  const s = sanitizePositionSettings(d);
  return s?.accountSize === d.accountSize && s.riskMode === d.riskMode && s.riskValue === d.riskValue && s.currency === d.currency;
}

/**
 * The risk value for `mode` that keeps the money at risk of `s` (percent ↔ amount): a percentage is capped at 100
 * and rounded to 4 decimals, an amount to 2 decimals.
 */
export function convertRiskValue(s: PositionDefaults, mode: PositionRiskMode): number {
  if (mode === s.riskMode) return s.riskValue;
  if (mode === 'percent') return Math.min(MAX_RISK_PERCENT, Math.round((s.riskValue / s.accountSize) * 100 * 1e4) / 1e4);
  return Math.round(s.accountSize * s.riskValue) / 100;
}

const APPEARANCE_THEMES: readonly AppearanceTheme[] = ['dark', 'light'];

/**
 * The per-theme appearance from a stored value. Layouts saved before appearance was per theme hold one flat
 * ChartAppearance: it was chosen in dark mode (the default theme), so it becomes the dark theme's settings.
 * Non-objects → undefined. Values are not validated here.
 */
export function migrateAppearance(a: unknown): ThemedAppearance | undefined {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return undefined;
  const keys = Object.keys(a);
  // Any theme key means the per-theme shape. A mixed object ({ dark: {...}, upColor: ... }) would lose its flat
  // keys here, but the server rejects mixed shapes, so stored layouts never hold one.
  if (keys.length > 0 && keys.every((k) => !(APPEARANCE_THEMES as readonly string[]).includes(k))) return { dark: a as ChartAppearance };
  return a as ThemedAppearance;
}
/**
 * Normalized drawing styles: `line` for line tools, `text` (annotation bubble colour + font size) for text,
 * `label` (price text on the line / price label on the y-axis) for price and horizontal lines; missing → defaults.
 */
export interface DrawingStyles {
  line?: DrawingLineStyle; text?: { color: string; size: number }; label?: { onLine?: boolean; onAxis?: boolean };
  /** Long / short positions: their own risk settings (over the defaults). */
  position?: PositionSettings;
}
/**
 * A saved drawing. Long / short positions ('longPosition' / 'shortPosition') have four points:
 * [0] entry { start time, entry price }, [1] { start time, target price }, [2] { start time, stop price },
 * [3] { end time, entry price } (points 1–2 repeat the start time and point 3 the entry price).
 */
export interface DrawingState { name: string; points: { timestamp: number; value: number }[]; lock: boolean; text?: string; styles?: DrawingStyles; anchorTf?: '1D'|'1W'|'1M' }
export interface WatchlistItem { id: SymbolId; position: number }

const ASSET_CLASSES: readonly AssetClass[] = ['stock', 'crypto', 'basket'];

export function parseSymbolId(id: string): { assetClass: AssetClass; code: string } {
  const i = id.indexOf(':');
  const prefix = i < 0 ? '' : id.slice(0, i);
  const code = i < 0 ? '' : id.slice(i + 1);
  const assetClass = ASSET_CLASSES.find((c) => c === prefix);
  if (!assetClass || code.length === 0) throw new Error(`invalid symbol: ${id}`);
  return { assetClass, code };
}

/** '#rrggbb'. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (s: unknown): s is string => typeof s === 'string' && HEX_COLOR_RE.test(s);
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 4;
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 24;

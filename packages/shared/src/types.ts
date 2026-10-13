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
  /** Histogram (bar figure) colors; default KLineChart's green/red. */
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
  /** Line / area chart line color and width (1–4). */
  lineColor?: string;
  lineWidth?: number;
  /** Style of new drawings. */
  drawing?: DrawingLineStyle;
}
export type AppearanceTheme = 'dark' | 'light';
/**
 * Global chart appearance, one set per theme (stored in the 'default' layout only): colors that read well on
 * the dark background rarely do on the light one, so each theme keeps its own settings.
 */
export interface ThemedAppearance { dark?: ChartAppearance; light?: ChartAppearance }
export interface Layout {
  symbol: SymbolId; tf: Timeframe; session: SessionMode; chartType: ChartType; indicators: IndicatorState[];
  appearance?: ThemedAppearance;
  /** Target / stop distances new long / short positions start with (missing → DEFAULT_POSITION_DEFAULTS). */
  positionDefaults?: PositionDefaults;
  /**
   * Revision of the default colors this layout's stored colors were last migrated to (missing → 0). The web app
   * clears colors equal to an older default once and then stores its current revision.
   */
  colorDefaultsRev?: number;
}

/** Long / short position drawing tools. */
export const POSITION_TOOLS = ['longPosition', 'shortPosition'] as const;
export type PositionTool = typeof POSITION_TOOLS[number];
export const isPositionTool = (name: string): name is PositionTool => (POSITION_TOOLS as readonly string[]).includes(name);
/**
 * Defaults of new long / short positions: the target / stop distance from the entry in % of the entry.
 * Positions are not sized (no account, risk or quantity) until brokers are connected; account-based sizing would
 * add its own fields next to these.
 */
export interface PositionDefaults { targetPct: number; stopPct: number }
export const DEFAULT_POSITION_DEFAULTS: Readonly<PositionDefaults> = { targetPct: 2, stopPct: 2 };
/** Largest default target / stop distance in % (below 100, so a short's target and a long's stop stay above zero). */
export const MAX_POSITION_PCT = 99;

const validPct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_POSITION_PCT;

/**
 * Stored position defaults with missing / invalid fields filled from DEFAULT_POSITION_DEFAULTS. Unknown fields
 * (e.g. the account / risk / currency of layouts saved when positions were sized) are ignored.
 */
export function resolvePositionDefaults(d: unknown): PositionDefaults {
  const out = { ...DEFAULT_POSITION_DEFAULTS };
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  const { targetPct, stopPct } = d as Record<string, unknown>;
  if (validPct(targetPct)) out.targetPct = targetPct;
  if (validPct(stopPct)) out.stopPct = stopPct;
  return out;
}

/** True when both distances are within the limits the server accepts for layout position defaults. */
export function isValidPositionDefaults(d: PositionDefaults): boolean {
  return validPct(d.targetPct) && validPct(d.stopPct);
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
 * Normalized drawing styles: `line` for line tools, `text` (annotation bubble color + font size) for text,
 * `label` (price text on the line / price label on the y-axis) for price and horizontal lines; `extend` (lines
 * extended past the left / right end) for parallel channels; missing → defaults (a new 'parallelChannel' is finite,
 * a legacy 'parallelStraightLine' is extended both ways).
 */
export interface DrawingStyles {
  line?: DrawingLineStyle; text?: { color: string; size: number }; label?: { onLine?: boolean; onAxis?: boolean };
  extend?: { left?: boolean; right?: boolean };
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

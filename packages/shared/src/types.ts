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
/**
 * A corporate event drawn on stock charts, at `ts` (UTC epoch ms): an earnings report (its reported time; `upcoming`
 * for the next scheduled one, with the consensus estimate only), a dividend (its ex-date; the amount per share, split
 * adjusted like the bars) or a split (its ex-date; `ratio` as reported, e.g. '4:1').
 */
export type CorporateEvent =
  | { kind: 'earnings'; ts: number; epsActual?: number; epsEstimate?: number; upcoming?: true }
  | { kind: 'dividend'; ts: number; amount: number }
  | { kind: 'split'; ts: number; ratio: string };
export type CorporateEventKind = CorporateEvent['kind'];
export const CORPORATE_EVENT_KINDS = ['earnings', 'dividend', 'split'] as const satisfies readonly CorporateEventKind[];
export interface EventsResponse { symbol: SymbolId; events: CorporateEvent[] }
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
  /**
   * Reference levels (dashed horizontal lines, e.g. RSI 70 / 30) of an oscillator; missing → the catalog
   * defaults. At most MAX_INDICATOR_LEVELS finite numbers.
   */
  levels?: number[];
  /** False hides the reference levels; missing → shown. */
  showLevels?: boolean;
}
/** Most reference levels an indicator may hold (enforced by the server's layout schema and the settings dialog). */
export const MAX_INDICATOR_LEVELS = 5;
/** Largest magnitude of a reference level. */
export const MAX_INDICATOR_LEVEL = 1e12;
export type ChartType = 'candle'|'ohlc'|'line'|'area';
/** Most indicators a layout may hold (enforced by the server's layout schema and the indicator picker). */
export const MAX_INDICATORS = 30;
/** Candle body style (chart type 'candle'): filled, hollow, hollow up candles only, hollow down candles only. */
export type CandleBodyStyle = 'solid'|'hollow'|'hollow_up'|'hollow_down';
/**
 * A drawing's line style. `color` is a #rrggbb hex (drawings saved before palette references, or the appearance's
 * default) or a DrawingColorToken resolved against the active theme when drawn.
 */
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
  /** Current (last) price line and its y-axis label: 'neutral' (default: white on dark, near-black on light) or the candle up / down color. */
  lastPriceLine?: LastPriceLineStyle;
}
/** Last price line color mode (see ChartAppearance.lastPriceLine). */
export type LastPriceLineStyle = 'neutral' | 'candle';
export const LAST_PRICE_LINE_STYLES: readonly LastPriceLineStyle[] = ['neutral', 'candle'];
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
  /**
   * Color of new drawings: the last swatch picked in a drawing's style bar ("Reset to default" removes it; missing →
   * the appearance's default drawing color). A DrawingColorToken, so one value suits both themes.
   */
  drawingColor?: string;
  /**
   * The rest of the style new drawings start with, as last set in a drawing's style bar (missing parts → the
   * appearance's default drawing style and each tool's own defaults). The color is `drawingColor`.
   */
  drawingDefaults?: DrawingDefaults;
  /** Corporate event kinds hidden on stock charts (missing or empty → earnings, dividends and splits all shown). */
  hiddenEvents?: CorporateEventKind[];
}

/** Drawings with price-label toggles (their own defaults differ, so each keeps its own last choice). */
export const LABELED_DRAWINGS = ['priceLine', 'horizontalStraightLine'] as const;
export type LabeledDrawing = typeof LABELED_DRAWINGS[number];

/** Style choices new drawings start with (see Layout.drawingDefaults); every field optional. */
export interface DrawingDefaults {
  /** Line width (px) and dash of line drawings (trend lines, rays, channels, rectangles, Fibonacci, …). */
  size?: number;
  style?: LineStyleKind;
  /** Font size of text annotations. */
  textSize?: number;
  /** Whether rectangles are filled. */
  fill?: boolean;
  /** Whether channels extend left / right. */
  extend?: { left: boolean; right: boolean };
  /** Price labels of price lines and horizontal lines, per tool. */
  labels?: Partial<Record<LabeledDrawing, { onLine: boolean; onAxis: boolean }>>;
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
 * a legacy 'parallelStraightLine' is extended both ways); `fill` (the tint inside) for rectangles (missing → filled).
 */
export interface DrawingStyles {
  line?: DrawingLineStyle;
  /**
   * A color of its own (palette reference or hex) without a `line` / `text` style: the width / dash (font size of
   * text) keep following the default drawing style. New drawings colored by the last picked swatch get only this.
   */
  color?: string; text?: { color: string; size: number }; label?: { onLine?: boolean; onAxis?: boolean };
  extend?: { left?: boolean; right?: boolean };
  /** Rectangles only: the tint inside (missing → filled; only `false` is stored). */
  fill?: boolean;
}
/**
 * A saved drawing. Long / short positions ('longPosition' / 'shortPosition') have four points:
 * [0] entry { start time, entry price }, [1] { start time, target price }, [2] { start time, stop price },
 * [3] { end time, entry price } (points 1–2 repeat the start time and point 3 the entry price).
 * `lock` is the effective lock when saved ("Lock all drawings" or the drawing's own lock); `locked` is the drawing's
 * own lock, which outlives "Lock all" being turned off (missing in drawings saved before it existed: see the web
 * ChartAdapter's restore for how they are read).
 */
export interface DrawingState {
  name: string; points: { timestamp: number; value: number }[]; lock: boolean; locked?: boolean;
  text?: string; styles?: DrawingStyles; anchorTf?: '1D'|'1W'|'1M';
}
export interface WatchlistItem { id: SymbolId; position: number }

const ASSET_CLASSES: readonly AssetClass[] = ['stock', 'crypto', 'basket'];

/** Stock / ETF / index codes as the stock provider spells them: AAPL, BRK-B, BRK.B, ^GSPC, ES=F. */
export const STOCK_CODE_RE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
/** Crypto base assets (priced in USD): BTC, ETH, 1000SATS. */
export const CRYPTO_CODE_RE = /^[A-Z0-9]{1,20}$/;
/** Basket ids are UUIDs (lowercase once normalized). */
export const BASKET_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longest symbol id accepted anywhere (`basket:` + a UUID is the longest valid one). */
export const MAX_SYMBOL_ID_LENGTH = 100;

/**
 * Parses and normalizes a symbol id: the whole id is trimmed, stock / crypto codes are uppercased and basket UUIDs
 * lowercased, so `crypto:btc` and `crypto:BTC` are the same symbol. The code must match its class's pattern
 * (STOCK_CODE_RE, CRYPTO_CODE_RE, BASKET_CODE_RE); anything else throws.
 */
export function parseSymbolId(id: string): { assetClass: AssetClass; code: string } {
  const bad = () => new Error(`invalid symbol: ${String(id).slice(0, MAX_SYMBOL_ID_LENGTH)}`);
  // Surrounding whitespace (any kind: tabs, newlines, no-break spaces) is trimmed, not refused; a padded id is
  // still bounded before the trim does any work.
  if (typeof id !== 'string' || id.length > 10 * MAX_SYMBOL_ID_LENGTH) throw bad();
  const s = id.trim();
  // ASCII only, checked before case folding: 'ß'.toUpperCase() is 'SS', which would alias another ticker.
  if (s.length > MAX_SYMBOL_ID_LENGTH || !/^[\x20-\x7e]*$/.test(s)) throw bad();
  const i = s.indexOf(':');
  const prefix = i < 0 ? '' : s.slice(0, i);
  const raw = i < 0 ? '' : s.slice(i + 1).trim();
  const assetClass = ASSET_CLASSES.find((c) => c === prefix);
  if (!assetClass) throw bad();
  const code = assetClass === 'basket' ? raw.toLowerCase() : raw.toUpperCase();
  const re = assetClass === 'stock' ? STOCK_CODE_RE : assetClass === 'crypto' ? CRYPTO_CODE_RE : BASKET_CODE_RE;
  if (!re.test(code)) throw bad();
  return { assetClass, code };
}

/** The canonical spelling of a symbol id (see parseSymbolId); throws when it is not a valid one. */
export function normalizeSymbolId(id: string): SymbolId {
  const { assetClass, code } = parseSymbolId(id);
  return `${assetClass}:${code}`;
}

/** The canonical spelling of `id`, or null when it is not a valid symbol id. */
export function tryNormalizeSymbolId(id: unknown): SymbolId | null {
  if (typeof id !== 'string') return null;
  try {
    return normalizeSymbolId(id);
  } catch {
    return null;
  }
}

/** '#rrggbb'. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (s: unknown): s is string => typeof s === 'string' && HEX_COLOR_RE.test(s);
/**
 * Theme palette references a drawing color can hold instead of a hex: the accent, the text and muted neutrals, the
 * candle up / down colors and the six indicator palette slots. The web app resolves them to the active theme's
 * colors when drawing, so a drawing recolors with the theme.
 */
export const DRAWING_COLOR_TOKENS = [
  'accent', 'text', 'muted', 'up', 'down', 'palette:0', 'palette:1', 'palette:2', 'palette:3', 'palette:4', 'palette:5',
] as const;
export type DrawingColorToken = typeof DRAWING_COLOR_TOKENS[number];
const DRAWING_COLOR_TOKEN_RE = /^(?:accent|text|muted|up|down|palette:[0-5])$/;
export const isDrawingColorToken = (s: unknown): s is DrawingColorToken => typeof s === 'string' && DRAWING_COLOR_TOKEN_RE.test(s);
/** A drawing color: a palette token or '#rrggbb'. */
export const DRAWING_COLOR_RE = /^(?:accent|text|muted|up|down|palette:[0-5]|#[0-9a-fA-F]{6})$/;
export const isDrawingColor = (s: unknown): s is string => typeof s === 'string' && DRAWING_COLOR_RE.test(s);
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 4;
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 24;

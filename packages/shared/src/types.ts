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
export interface Quote { id: SymbolId; price: number; changePct: number | null; ts: number }
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
 * Global chart appearance (stored in the 'default' layout only). Every field is optional: unset fields follow
 * the theme's defaults.
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
export interface Layout {
  symbol: SymbolId; tf: Timeframe; session: SessionMode; chartType: ChartType; indicators: IndicatorState[];
  appearance?: ChartAppearance;
}
/** Normalized drawing styles: `line` for line tools, `text` (annotation bubble colour + font size) for text. */
export interface DrawingStyles { line?: DrawingLineStyle; text?: { color: string; size: number } }
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

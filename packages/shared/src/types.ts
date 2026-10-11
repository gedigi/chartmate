export type Timeframe = '1m'|'5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'1D'|'1W'|'1M';
export type Session = 'pre'|'regular'|'post';
export type SessionMode = 'rth'|'eth';
export type AssetClass = 'stock'|'crypto'|'basket';
export type SymbolId = string; // 'stock:AAPL' | 'crypto:BTC' | 'basket:<uuid>'
export interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; session?: Session }
export interface SymbolInfo { id: SymbolId; assetClass: AssetClass; ticker: string; name: string; exchange?: string; pricePrecision: number }
export interface Quote { id: SymbolId; price: number; changePct: number | null; ts: number }
export interface BasketVersion { effectiveFrom: string /* 'YYYY-MM-DD' */; weights: Record<SymbolId, number> }
export interface Basket { id: string; name: string; baseValue: number; versions: BasketVersion[]; createdAt: number; updatedAt: number }
export interface Marker { ts: number; label: string }
export interface BarsResponse { symbol: SymbolId; tf: Timeframe; session: SessionMode; bars: Bar[]; hasMoreBefore: boolean; stale: boolean; notices: string[]; markers: Marker[] }
export interface LatestResponse { bar: Bar | null; stale: boolean }
export interface IndicatorState { name: string; pane: 'main'|'sub'; calcParams: number[]; visible: boolean; lineColors?: string[] }
export type ChartType = 'candle'|'ohlc'|'line'|'area';
export interface Layout { symbol: SymbolId; tf: Timeframe; session: SessionMode; chartType: ChartType; indicators: IndicatorState[] }
export interface DrawingState { name: string; points: { timestamp: number; value: number }[]; lock: boolean; text?: string; styles?: unknown }
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

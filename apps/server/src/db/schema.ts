export interface BarsTable { symbol: string; tf: string; ts: number; open: number; high: number; low: number; close: number; volume: number; session: string | null }
export interface CoverageTable { symbol: string; tf: string; from_ts: number; to_ts: number } // fetched [from,to) ranges
export interface SymbolsTable {
  id: string; name: string; exchange: string | null; price_precision: number; first_ts: number | null; updated_at: number;
  /** Provider ticker (null: rows written before migration 002 → derived from the id). */
  ticker: string | null;
  /** Last time stock splits were checked for this symbol (null = never). */
  splits_checked_at: number | null;
}
export interface BasketsTable { id: string; name: string; base_value: number; created_at: number; updated_at: number }
export interface BasketVersionsTable { basket_id: string; idx: number; effective_from: string; weights_json: string }
/** Legacy (pre-sections) watchlist; still mirrored with the symbols so an older server version keeps working. */
export interface WatchlistTable { symbol: string; position: number }
/**
 * Watchlist rows in order (migration 003): `kind` 'symbol' (with `symbol`) or 'section' (with `section_id`, `title`,
 * `collapsed` 0/1). A symbol belongs to the closest section header above it.
 */
export interface WatchlistEntriesTable {
  position: number; kind: string; symbol: string | null; section_id: string | null; title: string | null; collapsed: number | null;
}
export interface LayoutsTable { key: string; json: string; updated_at: number } // 'default' = last-used layout; per-symbol keys 'sym:<id>'
export interface DrawingsTable { symbol: string; json: string; updated_at: number }

export interface Database {
  bars: BarsTable;
  coverage: CoverageTable;
  symbols: SymbolsTable;
  baskets: BasketsTable;
  basket_versions: BasketVersionsTable;
  watchlist: WatchlistTable;
  watchlist_entries: WatchlistEntriesTable;
  layouts: LayoutsTable;
  drawings: DrawingsTable;
}

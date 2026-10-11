import type { Bar, NativeTimeframe, Quote, SessionWindow, SymbolInfo } from '@altv/shared';

export interface ProviderLimits {
  /** How far back from now data exists; absent = unlimited. */
  maxLookbackMs: Partial<Record<NativeTimeframe, number>>;
  /** Chunk size for one upstream request; absent = unlimited. */
  maxSpanPerRequestMs: Partial<Record<NativeTimeframe, number>>;
}

export interface FetchBarsResult {
  /** Sorted ascending by ts, deduped, normalized. */
  bars: Bar[];
  /** Listing date when the provider reports it (null = unknown). */
  firstTs?: number | null;
  /** Explicit session windows used for tagging (stocks intraday). */
  sessionWindows?: SessionWindow[];
}

export interface MarketDataProvider {
  readonly id: 'yahoo' | 'binance' | 'coinbase' | 'fixture';
  readonly assetClass: 'stock' | 'crypto';
  readonly limits: ProviderLimits;
  /** At most 20 results. */
  search(q: string): Promise<SymbolInfo[]>;
  /** Bars with ts in [from, to). */
  fetchBars(code: string, tf: NativeTimeframe, from: number, to: number): Promise<FetchBarsResult>;
  quotes(codes: string[]): Promise<Quote[]>;
  /** Listing date (null = unknown). */
  firstBarTs(code: string): Promise<number | null>;
}

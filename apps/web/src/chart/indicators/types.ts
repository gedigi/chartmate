import type { IndicatorTemplate } from 'klinecharts';

/** One entry in the indicator picker. */
export interface CatalogEntry {
  /** KLineChart indicator name (registered template name). */
  name: string;
  /** Human-readable name shown in the picker. */
  label: string;
  pane: 'main' | 'sub';
  defaultParams: number[];
  /** One label per param (settings dialog). */
  paramLabels: string[];
  /** One name per line figure, in figure order (colour inputs; colours map to `styles.lines[i]`). */
  lines: string[];
  /** Default colour per line when it differs from KLineChart's palette (`defaultLineColor`). */
  defaultColors?: string[];
  /** Draws histogram bars (styles.bars[0] up/down colours are editable). */
  bars?: boolean;
  /** Indices of params that accept decimals > 0; every other param must be an integer in 1…1000. */
  decimalParams?: number[];
  /** Optional longer explanation (picker / chip tooltip). */
  description?: string;
}

/**
 * A custom indicator: drop a file in `src/chart/indicators/custom/` whose default export has this shape and
 * it is registered with KLineChart and listed in the picker automatically.
 *
 * A default export of the wrong shape is skipped with a console warning, but a module that THROWS while
 * being evaluated is fatal: the files are bundled with an eager `import.meta.glob`, so the exception
 * propagates to the app's entry point and the app fails to start. Keep module top-level code side-effect free.
 */
export interface CustomIndicator {
  // `any`: templates differ in their result/extendData types.
  template: IndicatorTemplate<any, number, any>;
  catalog: CatalogEntry;
  /** Format values with the symbol's price precision (default precision 4 when unknown). */
  usePricePrecision?: boolean;
}

/** `extendData` the chart adapter passes to every indicator. */
export interface IndicatorExtendData {
  assetClass?: 'stock' | 'crypto' | 'basket';
  /** False on 1D and longer timeframes (session-anchored indicators then span the whole series). */
  intraday?: boolean;
  pricePrecision?: number;
}

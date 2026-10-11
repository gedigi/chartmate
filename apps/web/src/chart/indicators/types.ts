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
  /** Indices of params that accept decimals > 0; every other param must be an integer ≥ 1. */
  decimalParams?: number[];
}

/**
 * A custom indicator: drop a file in `src/chart/indicators/custom/` whose default export has this shape and
 * it is registered with KLineChart and listed in the picker automatically.
 */
export interface CustomIndicator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- templates differ in their result/extendData types
  template: IndicatorTemplate<any, number, any>;
  catalog: CatalogEntry;
}

/** `extendData` the chart adapter passes to every indicator. */
export interface IndicatorExtendData { assetClass?: 'stock' | 'crypto' | 'basket' }

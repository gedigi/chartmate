import type { Layout, SymbolInfo } from '@altv/shared';
import type { JSX } from 'react';

export interface ChartViewProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Null while the symbol's info is loading or failed to load. */
  symbolInfo: SymbolInfo | null;
  theme: 'dark' | 'light';
}

/**
 * Owns the whole chart region: the left drawing-toolbar column and the chart area (with indicator chips,
 * stale badge, etc.). The root fills its grid cell; `.chart-view` is itself a 2-column grid.
 * STUB — implemented by Task 10 (chart), 11 (indicators) and 12 (drawing toolbar).
 */
export function ChartView({ layout }: ChartViewProps): JSX.Element {
  return (
    <div className="chart-view" data-testid="chart-view">
      <div className="left-toolbar" aria-label="Drawing tools" />
      <div className="chart-area placeholder">Chart: {layout.symbol} · {layout.tf}</div>
    </div>
  );
}

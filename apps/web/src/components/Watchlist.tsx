import type { SymbolId } from '@altv/shared';
import type { JSX } from 'react';

export interface WatchlistProps {
  currentSymbol: SymbolId;
  onSelect: (id: SymbolId) => void;
}

/** Right-sidebar watchlist. STUB — implemented by Task 13. */
export function Watchlist(_props: WatchlistProps): JSX.Element {
  return (
    <section className="watchlist placeholder" data-testid="watchlist" aria-label="Watchlist">
      <h2 className="panel-title">Watchlist</h2>
    </section>
  );
}

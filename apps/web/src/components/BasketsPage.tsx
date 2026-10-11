import type { SymbolId } from '@altv/shared';
import type { JSX } from 'react';

export interface BasketsPageProps {
  /** Opens `id` on the chart view (App sets layout.symbol and switches view). */
  onOpenChart: (id: SymbolId) => void;
}

/** Baskets list/editor view. STUB — implemented by Task 14. */
export function BasketsPage(_props: BasketsPageProps): JSX.Element {
  return (
    <section className="baskets-page placeholder" data-testid="baskets-page" aria-label="Baskets">
      <h2 className="panel-title">Baskets</h2>
    </section>
  );
}

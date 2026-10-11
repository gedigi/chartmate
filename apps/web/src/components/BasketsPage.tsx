import type { Basket, Quote, SymbolId } from '@altv/shared';
import { useState, type JSX } from 'react';
import { errorMessage } from '../api/client';
import { basketSymbol, useBaskets } from '../state/useBaskets';
import { BasketEditor, weightsSummary } from './BasketEditor';
import './Baskets.css';

export interface BasketsPageProps {
  /** Opens `id` on the chart view (App sets layout.symbol and switches view). */
  onOpenChart: (id: SymbolId) => void;
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; id: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function QuoteCell({ quote }: { quote: Quote | undefined }): JSX.Element {
  if (!quote) return <span className="muted">—</span>;
  const pct = quote.changePct;
  return (
    <span className="basket-quote">
      <span className="basket-price">{quote.price.toFixed(2)}</span>
      {pct !== null && (
        <span className={pct >= 0 ? 'up' : 'down'}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>
      )}
    </span>
  );
}

/** Baskets list, plus the create/edit editor. */
export function BasketsPage({ onOpenChart }: BasketsPageProps): JSX.Element {
  const { baskets, quotes, status, error, reload, upsert, remove } = useBaskets();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [rowError, setRowError] = useState<string | null>(null);

  const editing = mode.kind === 'edit' ? baskets.find((b) => b.id === mode.id) : undefined;

  async function onDelete(b: Basket) {
    if (!window.confirm(`Delete basket "${b.name}"? This cannot be undone.`)) return;
    setRowError(null);
    try {
      await remove(b.id);
    } catch (err) {
      setRowError(`Could not delete "${b.name}": ${errorMessage(err)}`);
    }
  }

  let body: JSX.Element;
  if (mode.kind === 'create') {
    body = (
      <BasketEditor
        onSaved={(b) => { upsert(b); setMode({ kind: 'list' }); }}
        onCancel={() => setMode({ kind: 'list' })}
      />
    );
  } else if (mode.kind === 'edit' && editing) {
    body = <BasketEditor basket={editing} onSaved={upsert} onCancel={() => setMode({ kind: 'list' })} />;
  } else {
    body = (
      <>
        <div className="baskets-header">
          <h2>Baskets</h2>
          <button type="button" className="primary" onClick={() => setMode({ kind: 'create' })}>New basket</button>
        </div>
        {status === 'loading' && <p className="muted">Loading baskets…</p>}
        {status === 'error' && (
          <div className="form-error" role="alert">
            Could not load baskets: {error} <button type="button" onClick={reload}>Retry</button>
          </div>
        )}
        {rowError && <p className="form-error" role="alert">{rowError}</p>}
        {status === 'ready' && baskets.length === 0 && (
          <p className="muted">No baskets yet. Create one to track a custom weighted index of stocks and crypto.</p>
        )}
        {baskets.length > 0 && (
          <ul className="basket-list" aria-label="Baskets">
            {baskets.map((b) => {
              const latest = b.versions[b.versions.length - 1];
              const n = latest ? Object.keys(latest.weights).length : 0;
              return (
                <li key={b.id} className="basket-row" data-testid="basket-row">
                  <div className="basket-main">
                    <span className="basket-name">{b.name}</span>
                    <span className="basket-meta">
                      {plural(n, 'constituent')} · {plural(b.versions.length, 'version')}
                      {latest && <> · since {b.versions[0]!.effectiveFrom}</>}
                    </span>
                    {latest && <span className="basket-weights">{weightsSummary(latest.weights)}</span>}
                  </div>
                  <QuoteCell quote={quotes[basketSymbol(b.id)]} />
                  <div className="basket-actions">
                    <button type="button" className="primary" onClick={() => onOpenChart(basketSymbol(b.id))}>Open chart</button>
                    <button type="button" onClick={() => setMode({ kind: 'edit', id: b.id })}>Edit</button>
                    <button type="button" className="danger" onClick={() => void onDelete(b)}>Delete</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="baskets-page" data-testid="baskets-page" aria-label="Baskets">
      {body}
    </section>
  );
}

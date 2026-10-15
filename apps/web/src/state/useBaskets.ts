import type { Basket, Quote, SymbolId } from '@chartmate/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { drawingsStore } from './drawingsStore';

export type BasketsStatus = 'loading' | 'ready' | 'error';

export interface UseBaskets {
  baskets: Basket[];
  /** Current value per basket symbol id (`basket:<id>`); missing when unavailable. */
  quotes: Record<SymbolId, Quote>;
  /** State of the list's quote request: a missing quote only means "unavailable" once it is not 'loading'. */
  quotesStatus: 'loading' | 'loaded' | 'failed';
  status: BasketsStatus;
  error: string | null;
  reload: () => void;
  /** Replaces (or adds) a basket after a save and refreshes its quote. */
  upsert: (b: Basket) => void;
  /**
   * Deletes on the server, then locally; then drops the basket from the watchlist and clears its drawings (best
   * effort, in the background: never delays or fails the delete). Rejects with the API error of the delete only.
   */
  remove: (id: string) => Promise<void>;
}

export const basketSymbol = (id: string): SymbolId => `basket:${id}`;

type BasketListener = (id: string) => void;
const basketListeners = new Set<BasketListener>();

/** Subscribes to "basket `id` was created, edited or deleted". Returns the unsubscribe function. */
export function onBasketChanged(cb: BasketListener): () => void {
  basketListeners.add(cb);
  return () => { basketListeners.delete(cb); };
}

/** Tells subscribers (e.g. the chart's RTH/ETH toggle) that a basket changed on the server. */
export function notifyBasketChanged(id: string): void {
  for (const cb of [...basketListeners]) cb(id);
}

const deletedListeners = new Set<BasketListener>();

/** Subscribes to "basket `id` was deleted" (e.g. the chart switches away from it). Returns the unsubscribe function. */
export function onBasketDeleted(cb: BasketListener): () => void {
  deletedListeners.add(cb);
  return () => { deletedListeners.delete(cb); };
}

/** Tells subscribers that basket `id` was deleted on the server. */
export function notifyBasketDeleted(id: string): void {
  for (const cb of [...deletedListeners]) cb(id);
}

/**
 * Best-effort cleanup of a deleted basket's references, in the background: its watchlist row (the stored list; the
 * watchlist is not mounted on the Baskets page and reloads when it is) and its drawings. A failure is logged and
 * leaves a stale reference, which the watchlist and the chart show as "Deleted basket". A legacy per-symbol layout
 * row (`sym:basket:<id>`) cannot be removed: the API has no layout delete, and those rows are never read.
 */
function dropBasketReferences(symbol: SymbolId): void {
  void Promise.allSettled([
    api.watchlist.get().then((list) => {
      const next = list.filter((e) => !(e.type === 'symbol' && e.id === symbol));
      return next.length === list.length ? undefined : api.watchlist.put(next);
    }),
    api.drawings.put(symbol, []),
  ]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') console.warn(`Cleanup after deleting ${symbol} failed:`, errorMessage(r.reason));
    }
  });
}

/** Basket list + current values for the Baskets page. Quote failures are non-fatal (values show as "—"). */
export function useBaskets(): UseBaskets {
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [quotes, setQuotes] = useState<Record<SymbolId, Quote>>({});
  const [quotesStatus, setQuotesStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [status, setStatus] = useState<BasketsStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  /** `list`: the whole list's quotes (drives quotesStatus); otherwise one refreshed basket. */
  const loadQuotes = useCallback((ids: string[], g: number, list = false) => {
    if (ids.length === 0) {
      if (list) setQuotesStatus('loaded');
      return;
    }
    if (list) setQuotesStatus('loading');
    api.quotes(ids.map(basketSymbol)).then(
      (qs) => {
        if (g !== gen.current) return;
        if (list) setQuotesStatus('loaded');
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of qs) next[q.id] = q;
          return next;
        });
      },
      () => { if (list && g === gen.current) setQuotesStatus('failed'); /* values stay unavailable */ },
    );
  }, []);

  const reload = useCallback(() => {
    const g = ++gen.current;
    setStatus('loading');
    setError(null);
    api.baskets.list().then(
      (list) => {
        if (g !== gen.current) return;
        setBaskets(list);
        setStatus('ready');
        loadQuotes(list.map((b) => b.id), g, true);
      },
      (err: unknown) => {
        if (g !== gen.current) return;
        setError(errorMessage(err));
        setStatus('error');
      },
    );
  }, [loadQuotes]);

  useEffect(() => {
    reload();
    return () => { gen.current++; };
  }, [reload]);

  const upsert = useCallback((b: Basket) => {
    setBaskets((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b]));
    loadQuotes([b.id], gen.current);
    notifyBasketChanged(b.id);
  }, [loadQuotes]);

  const remove = useCallback(async (id: string) => {
    await api.baskets.remove(id);
    setBaskets((list) => list.filter((b) => b.id !== id));
    setQuotes((q) => {
      const next = { ...q };
      delete next[basketSymbol(id)];
      return next;
    });
    notifyBasketChanged(id);
    // Its unsaved drawings (a save still retrying or stalled) must never be re-sent after the cleanup below.
    drawingsStore.cancel(basketSymbol(id));
    notifyBasketDeleted(id);
    dropBasketReferences(basketSymbol(id));
  }, []);

  return { baskets, quotes, quotesStatus, status, error, reload, upsert, remove };
}

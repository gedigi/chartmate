import type { Basket, Quote, SymbolId } from '@altv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';

export type BasketsStatus = 'loading' | 'ready' | 'error';

export interface UseBaskets {
  baskets: Basket[];
  /** Current value per basket symbol id (`basket:<id>`); missing when unavailable. */
  quotes: Record<SymbolId, Quote>;
  status: BasketsStatus;
  error: string | null;
  reload: () => void;
  /** Replaces (or adds) a basket after a save and refreshes its quote. */
  upsert: (b: Basket) => void;
  /** Deletes on the server, then locally. Rejects with the API error. */
  remove: (id: string) => Promise<void>;
}

export const basketSymbol = (id: string): SymbolId => `basket:${id}`;

/** Basket list + current values for the Baskets page. Quote failures are non-fatal (values show as "—"). */
export function useBaskets(): UseBaskets {
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [quotes, setQuotes] = useState<Record<SymbolId, Quote>>({});
  const [status, setStatus] = useState<BasketsStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const loadQuotes = useCallback((ids: string[], g: number) => {
    if (ids.length === 0) return;
    api.quotes(ids.map(basketSymbol)).then(
      (qs) => {
        if (g !== gen.current) return;
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of qs) next[q.id] = q;
          return next;
        });
      },
      () => { /* values stay unavailable */ },
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
        loadQuotes(list.map((b) => b.id), g);
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
  }, [loadQuotes]);

  const remove = useCallback(async (id: string) => {
    await api.baskets.remove(id);
    setBaskets((list) => list.filter((b) => b.id !== id));
    setQuotes((q) => {
      const next = { ...q };
      delete next[basketSymbol(id)];
      return next;
    });
  }, []);

  return { baskets, quotes, status, error, reload, upsert, remove };
}

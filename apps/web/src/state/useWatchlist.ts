import type { SymbolId } from '@altv/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useDebouncedSave } from './useDebouncedSave';

export const DEFAULT_WATCHLIST: SymbolId[] = ['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH'];
export const INITIALIZED_KEY = 'altv.watchlist.initialized';
const SAVE_DELAY_MS = 500;

function readFlag(): boolean {
  try { return localStorage.getItem(INITIALIZED_KEY) !== null; } catch { return false; }
}
function setFlag(): void {
  try { localStorage.setItem(INITIALIZED_KEY, '1'); } catch { /* storage unavailable */ }
}

async function saveList(ids: SymbolId[]): Promise<void> {
  await api.watchlist.put(ids);
  setFlag();
}

export interface UseWatchlist {
  ids: SymbolId[];
  loaded: boolean;
  error: string | null;
  add: (id: SymbolId) => void;
  remove: (id: SymbolId) => void;
  move: (from: number, to: number) => void;
}

/** Watchlist state: loaded from the server, seeded with defaults on first run, saved debounced. */
export function useWatchlist(): UseWatchlist {
  const [ids, setIds] = useState<SymbolId[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.watchlist.get().then(
      (list) => {
        if (cancelled) return;
        if (list.length === 0 && !readFlag()) {
          setIds(DEFAULT_WATCHLIST);
          setLoaded(true);
          saveList(DEFAULT_WATCHLIST).catch((err: unknown) => { if (!cancelled) setLoadError(errorMessage(err)); });
        } else {
          setIds(list);
          setLoaded(true);
        }
      },
      (err: unknown) => { if (!cancelled) setLoadError(errorMessage(err)); },
    );
    return () => { cancelled = true; };
  }, []);

  // Saving stays disabled until the server list is loaded (so a failed load never overwrites it).
  const { error: saveError } = useDebouncedSave(ids, saveList, SAVE_DELAY_MS, loaded);

  const add = useCallback((id: SymbolId) => {
    setIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
  }, []);
  const remove = useCallback((id: SymbolId) => {
    setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur));
  }, []);
  const move = useCallback((from: number, to: number) => {
    setIds((cur) => {
      if (from === to || from < 0 || to < 0 || from >= cur.length || to >= cur.length) return cur;
      const next = cur.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  }, []);

  return { ids, loaded, error: loadError ?? saveError, add, remove, move };
}

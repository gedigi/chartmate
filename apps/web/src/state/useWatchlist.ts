import { MAX_WATCHLIST_SYMBOLS, watchlistSymbols, type SymbolId, type WatchlistEntry } from '@chartmate/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { readStored, writeStored } from './storage';
import { useDebouncedSave } from './useDebouncedSave';
import { addSymbol, removeSymbol } from './watchlistModel';

export const DEFAULT_WATCHLIST: SymbolId[] = ['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH'];
/** Stored as `chartmate.watchlist.initialized` (state/storage.ts). */
export const INITIALIZED_KEY = 'watchlist.initialized';
const SAVE_DELAY_MS = 500;
const DEFAULT_ENTRIES: WatchlistEntry[] = DEFAULT_WATCHLIST.map((id) => ({ type: 'symbol', id }));

function readFlag(): boolean {
  return readStored(INITIALIZED_KEY) !== null;
}
function setFlag(): void {
  writeStored(INITIALIZED_KEY, '1');
}

export interface UseWatchlist {
  /** Symbols and section headers, in order. */
  entries: WatchlistEntry[];
  /** The symbol ids only, in order. */
  ids: SymbolId[];
  loaded: boolean;
  error: string | null;
  /** Adds a symbol at the end of `sectionId` (or of the list); duplicates are ignored. */
  add: (id: SymbolId, sectionId?: string | null) => void;
  remove: (id: SymbolId) => void;
  /** Applies a pure entry-list operation (see watchlistModel). */
  update: (fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => void;
}

/** Watchlist state: loaded from the server, seeded with defaults on first run, saved debounced. */
export function useWatchlist(): UseWatchlist {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  const saveList = useCallback(async (list: WatchlistEntry[]): Promise<void> => {
    await api.watchlist.put(list);
    setFlag();
    setSeedError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.watchlist.get().then(
      (list) => {
        if (cancelled) return;
        if (list.length === 0 && !readFlag()) {
          setEntries(DEFAULT_ENTRIES);
          setLoaded(true);
          saveList(DEFAULT_ENTRIES).catch((err: unknown) => { if (!cancelled) setSeedError(errorMessage(err)); });
        } else {
          setEntries(list);
          setLoaded(true);
        }
      },
      (err: unknown) => { if (!cancelled) setLoadError(errorMessage(err)); },
    );
    return () => { cancelled = true; };
  }, [saveList]);

  // Saving stays disabled until the server list is loaded (so a failed load never overwrites it).
  const { error: saveError } = useDebouncedSave(entries, saveList, SAVE_DELAY_MS, loaded);

  const add = useCallback((id: SymbolId, sectionId: string | null = null) => {
    setEntries((cur) => (watchlistSymbols(cur).length >= MAX_WATCHLIST_SYMBOLS ? cur : addSymbol(cur, id, sectionId)));
  }, []);
  const remove = useCallback((id: SymbolId) => setEntries((cur) => removeSymbol(cur, id)), []);
  const update = useCallback((fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => setEntries(fn), []);
  const ids = useMemo(() => watchlistSymbols(entries), [entries]);

  return { entries, ids, loaded, error: loadError ?? saveError ?? seedError, add, remove, update };
}

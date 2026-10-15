import { MAX_WATCHLIST_SYMBOLS, watchlistSymbols, type SymbolId, type WatchlistEntry } from '@chartmate/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { retryDelayMs } from './retry';
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
  /** False until the server list is loaded; edits are ignored meanwhile (the load would replace them). */
  loaded: boolean;
  error: string | null;
  /** Adds a symbol at the end of `sectionId` (or of the list); duplicates are ignored. */
  add: (id: SymbolId, sectionId?: string | null) => void;
  remove: (id: SymbolId) => void;
  /** Applies a pure entry-list operation (see watchlistModel). */
  update: (fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => void;
}

/**
 * Watchlist state: loaded from the server (a failed load is retried with backoff), seeded with defaults on first run,
 * saved debounced (a failed save is retried with backoff). Edits are ignored until the list is loaded.
 */
export function useWatchlist(): UseWatchlist {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const saveList = useCallback(async (list: WatchlistEntry[]): Promise<void> => {
    await api.watchlist.put(list);
    setFlag();
    setSeedError(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.watchlist.get().then(
        (list) => {
          if (canceled) return;
          setLoadError(null);
          if (list.length === 0 && !readFlag()) {
            setEntries(DEFAULT_ENTRIES);
            setLoaded(true);
            saveList(DEFAULT_ENTRIES).catch((err: unknown) => { if (!canceled) setSeedError(errorMessage(err)); });
          } else {
            setEntries(list);
            setLoaded(true);
          }
        },
        (err: unknown) => {
          if (canceled) return;
          setLoadError(errorMessage(err));
          timer = setTimeout(() => load(attempt + 1), retryDelayMs(attempt));
        },
      );
    };
    load(0);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [saveList]);

  // Saving stays disabled until the server list is loaded (so a failed load never overwrites it).
  const { error: saveError } = useDebouncedSave(entries, saveList, SAVE_DELAY_MS, loaded, { retry: true });

  // Edits before the load would be replaced by the loaded list (and never saved): ignored.
  const edit = useCallback((fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => setEntries((cur) => (loadedRef.current ? fn(cur) : cur)), []);
  const add = useCallback((id: SymbolId, sectionId: string | null = null) => {
    edit((cur) => (watchlistSymbols(cur).length >= MAX_WATCHLIST_SYMBOLS ? cur : addSymbol(cur, id, sectionId)));
  }, [edit]);
  const remove = useCallback((id: SymbolId) => edit((cur) => removeSymbol(cur, id)), [edit]);
  const update = edit;
  const ids = useMemo(() => watchlistSymbols(entries), [entries]);

  return { entries, ids, loaded, error: loadError ?? saveError ?? seedError, add, remove, update };
}

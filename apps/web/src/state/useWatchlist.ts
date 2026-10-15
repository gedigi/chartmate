import { MAX_WATCHLIST_SYMBOLS, watchlistSymbols, type SymbolId, type WatchlistEntry } from '@chartmate/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isPermanentError } from '../api/client';
import type { SaveNoteState } from '../components/SaveNote';
import { retryDelayMs } from './retry';
import { readStored } from './storage';
import { onBasketDeleted } from './useBaskets';
import { useDebouncedSave } from './useDebouncedSave';
import { addSymbol, removeSymbol } from './watchlistModel';

export const DEFAULT_WATCHLIST: SymbolId[] = ['stock:SPY', 'stock:AAPL', 'crypto:BTC', 'crypto:ETH'];
/**
 * `chartmate.watchlist.initialized` (state/storage.ts): the per-device "already seeded" flag of earlier versions.
 * No longer written (the server says whether a list was ever stored); still read, because a device that seeded
 * with an earlier version knows its list was stored even where the server has no marker yet.
 */
export const INITIALIZED_KEY = 'watchlist.initialized';
const SAVE_DELAY_MS = 500;
const DEFAULT_ENTRIES: WatchlistEntry[] = DEFAULT_WATCHLIST.map((id) => ({ type: 'symbol', id }));

/**
 * What to do with a loaded list. `seed`: save the defaults, only for an empty list that was never stored as far
 * as both the server and this device know (`stored` is null from an older server). `mark`: the list was emptied
 * before the server kept a marker (this device's old flag says it was stored): save it as is once, so the server
 * records it and no other device seeds over it. `keep` otherwise.
 */
export function seedAction(entries: readonly WatchlistEntry[], stored: boolean | null): 'seed' | 'mark' | 'keep' {
  if (entries.length > 0 || stored === true) return 'keep';
  if (readStored(INITIALIZED_KEY) === null) return 'seed';
  return stored === false ? 'mark' : 'keep';
}

/**
 * What the watchlist shows about LOADING, if anything (a quiet muted line): `retrying` a transient failure being
 * retried; `failed` a permanent one (the list stays read-only). `detail` is the raw error (a tooltip).
 */
export interface WatchlistStatus {
  kind: 'retrying' | 'failed';
  text: string;
  detail: string;
}

/** A save that has not reached the server (shown with SaveNote, like the layout and drawings). */
export interface WatchlistSaveNote {
  state: SaveNoteState;
  detail: string;
}

export interface UseWatchlist {
  /** Symbols and section headers, in order. */
  entries: WatchlistEntry[];
  /** The symbol ids only, in order. */
  ids: SymbolId[];
  /** False until the server list is loaded; edits are ignored meanwhile (the load would replace them). */
  loaded: boolean;
  status: WatchlistStatus | null;
  saveNote: WatchlistSaveNote | null;
  /** Saves again at once after saving stalled. */
  retrySave: () => void;
  /** Adds a symbol at the end of `sectionId` (or of the list); duplicates are ignored. */
  add: (id: SymbolId, sectionId?: string | null) => void;
  remove: (id: SymbolId) => void;
  /** Applies a pure entry-list operation (see watchlistModel). */
  update: (fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => void;
}

/**
 * Watchlist state: loaded from the server (a failed load is retried with backoff), seeded with defaults when the
 * server never stored a list, saved debounced (a failed save is retried with backoff). Edits are ignored until the
 * list is loaded.
 */
export function useWatchlist(): UseWatchlist {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadStatus, setLoadStatus] = useState<WatchlistStatus | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const saveList = useCallback(async (list: WatchlistEntry[]): Promise<void> => {
    await api.watchlist.put(list);
    setSeedError(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.watchlist.load().then(
        ({ entries: list, stored }) => {
          if (canceled) return;
          setLoadStatus(null);
          const action = seedAction(list, stored);
          if (action === 'seed') {
            setEntries(DEFAULT_ENTRIES);
            setLoaded(true);
            saveList(DEFAULT_ENTRIES).catch((err: unknown) => { if (!canceled) setSeedError(errorMessage(err)); });
          } else {
            // Best effort: a failed marker save only means the next load tries again.
            if (action === 'mark') api.watchlist.put(list).catch(() => {});
            setEntries(list);
            setLoaded(true);
          }
        },
        (err: unknown) => {
          if (canceled) return;
          const detail = errorMessage(err);
          // A permanent failure (e.g. 403) cannot succeed by retrying: the list stays read-only.
          if (isPermanentError(err)) {
            setLoadStatus({ kind: 'failed', text: "Couldn't load the watchlist.", detail });
            return;
          }
          setLoadStatus({ kind: 'retrying', text: "Can't reach the server. Retrying…", detail });
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
  const save = useDebouncedSave(entries, saveList, SAVE_DELAY_MS, loaded, { retry: true });
  const saveNote: WatchlistSaveNote | null = save.error !== null
    ? { state: save.permanent ? 'failed' : save.stalled ? 'stalled' : 'retrying', detail: save.error }
    : seedError !== null ? { state: 'failed', detail: seedError } : null;

  // Edits before the load would be replaced by the loaded list (and never saved): ignored.
  const edit = useCallback((fn: (cur: WatchlistEntry[]) => WatchlistEntry[]) => setEntries((cur) => (loadedRef.current ? fn(cur) : cur)), []);
  const add = useCallback((id: SymbolId, sectionId: string | null = null) => {
    edit((cur) => (watchlistSymbols(cur).length >= MAX_WATCHLIST_SYMBOLS ? cur : addSymbol(cur, id, sectionId)));
  }, [edit]);
  const remove = useCallback((id: SymbolId) => edit((cur) => removeSymbol(cur, id)), [edit]);
  const update = edit;
  // A basket deleted while the list is shown leaves it (the Baskets page also drops it from the stored list).
  useEffect(() => onBasketDeleted((id) => edit((cur) => removeSymbol(cur, `basket:${id}`))), [edit]);
  const ids = useMemo(() => watchlistSymbols(entries), [entries]);

  return { entries, ids, loaded, status: loadStatus, saveNote, retrySave: save.retryNow, add, remove, update };
}

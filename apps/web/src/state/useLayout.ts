import type { Layout, SymbolId } from '@altv/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { retryDelayMs } from './retry';
import { useDebouncedSave } from './useDebouncedSave';

export const DEFAULT_LAYOUT: Layout = {
  symbol: 'crypto:BTC',
  tf: '1D',
  session: 'rth',
  chartType: 'candle',
  indicators: [{ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true }],
};

export const symbolLayoutKey = (symbol: string) => `sym:${symbol}`;

/** A layout as stored under `sym:<id>`: appearance is global and lives in the `default` layout only. */
export function symbolLayout(l: Layout): Layout {
  const { appearance: _global, ...rest } = l;
  return rest;
}

export interface UseLayout {
  layout: Layout;
  /** Ignored until `loaded` (the `default` load replaces the whole layout). */
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Switches the symbol; before `loaded` the choice is queued and applied on top of the loaded layout. */
  selectSymbol: (id: SymbolId) => void;
  loaded: boolean;
  /** Set while the `default` layout cannot be loaded (other than 404); it is retried with backoff. */
  loadError: string | null;
  /** Retries the `default` load now. */
  retry: () => void;
}

/**
 * The current chart layout.
 * - Loads the `default` layout on mount. Only a 404 falls back to DEFAULT_LAYOUT; any other failure keeps
 *   `loaded` false (so nothing is saved over the user's layout), exposes `loadError` and retries with backoff.
 * - Whenever the symbol changes, loads `sym:<id>` (retried with backoff on failure) and, if present, adopts its
 *   indicators. If the user edits indicators on that symbol before the load resolves, their edit wins: the
 *   loaded indicators are not adopted and the edit is written to `sym:<id>` instead.
 * - `appearance` is global: it comes from `default` only and is never written to (or adopted from) `sym:<id>`.
 * - Saves `default` (whole layout) and `sym:<id>` (for the current symbol) debounced. The per-symbol key is
 *   only written after that symbol's own layout has been loaded, so merely visiting a symbol does not
 *   snapshot the carried-over indicators onto it, and only when the indicators change by value (tf /
 *   chart-type changes do not touch it).
 * Callers should not offer edits until `loaded` is true: the `default` load replaces the whole layout.
 */
export function useLayout(): UseLayout {
  const [layout, setLayoutState] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  /** Symbol chosen before the default layout loaded; applied right after. */
  const queuedSymbol = useRef<SymbolId | null>(null);
  /** Symbol whose `sym:` layout has finished loading (null while a load is in flight). */
  const [symLoadedFor, setSymLoadedFor] = useState<string | null>(null);
  /** Mirrors symLoadedFor synchronously (read inside state updaters). */
  const symDone = useRef<string | null>(null);
  /** Symbol whose indicators the user changed while its `sym:` load was in flight (or not yet started). */
  const editedSym = useRef<string | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    if (loadedRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.layouts.get('default').then(
        (l) => {
          if (cancelled) return;
          if (l) setLayoutState(l); // null = 404: nothing saved yet → DEFAULT_LAYOUT
          setLoadError(null);
          setLoaded(true);
        },
        (err: unknown) => {
          if (cancelled) return;
          setLoadError(errorMessage(err));
          timer = setTimeout(() => load(attempt + 1), retryDelayMs(attempt));
        },
      );
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadKey]);

  const retry = useCallback(() => { if (!loadedRef.current) setLoadKey((k) => k + 1); }, []);

  // A symbol picked before the default layout arrived wins over the loaded one (a change, so it is saved).
  useEffect(() => {
    const id = queuedSymbol.current;
    if (!loaded || id === null) return;
    queuedSymbol.current = null;
    setLayoutState((cur) => (cur.symbol === id ? cur : { ...cur, symbol: id }));
  }, [loaded]);

  const symbol = layout.symbol;
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setSymLoadedFor(null);
    symDone.current = null;
    if (editedSym.current !== symbol) editedSym.current = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.layouts.get(symbolLayoutKey(symbol)).then(
        (l) => {
          if (cancelled) return;
          symDone.current = symbol;
          if (editedSym.current === symbol) {
            editedSym.current = null;
            // Keep the user's edit and persist it under this symbol (the debounced saver treats the value at
            // enable time as the baseline, so it would not write it).
            const cur = layoutRef.current;
            if (cur.symbol === symbol) api.layouts.put(symbolLayoutKey(symbol), symbolLayout(cur)).catch(() => { /* next edit retries */ });
          } else if (l) {
            setLayoutState((cur) => (cur.symbol === symbol ? { ...cur, indicators: l.indicators } : cur));
          }
          setSymLoadedFor(symbol);
        },
        // Retried until it loads: until then an edit on this symbol is remembered (editedSym) and written once
        // the load succeeds, instead of being dropped or overwriting a sym: layout we have not seen.
        () => { if (!cancelled) timer = setTimeout(() => load(attempt + 1), retryDelayMs(attempt)); },
      );
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbol, loaded]);

  const saveDefault = useCallback((l: Layout) => api.layouts.put('default', l), []);
  const saveSymbol = useCallback((l: Layout) => api.layouts.put(symbolLayoutKey(l.symbol), symbolLayout(l)), []);
  useDebouncedSave(layout, saveDefault, 1000, loaded);
  // Identity changes only when the symbol or the indicators (by value) change.
  const indicatorsJson = JSON.stringify(layout.indicators);
  // Deliberately keyed on symbol + indicators only (tf/chartType changes must not re-save sym:<id>).
  const symValue = useMemo(() => layout, [symbol, indicatorsJson]);
  useDebouncedSave(symValue, saveSymbol, 1000, loaded && symLoadedFor === symbol);

  const setLayout = useCallback((fn: (l: Layout) => Layout) => setLayoutState((cur) => {
    if (!loadedRef.current) return cur; // the default load would overwrite it (and saves are off): ignore
    const next = fn(cur);
    // Idempotent (safe under StrictMode's double-invoked updaters).
    if (loadedRef.current && symDone.current !== cur.symbol && next.symbol === cur.symbol
      && JSON.stringify(next.indicators) !== JSON.stringify(cur.indicators)) {
      editedSym.current = cur.symbol;
    }
    return next;
  }), []);
  const selectSymbol = useCallback((id: SymbolId) => {
    if (!loadedRef.current) {
      queuedSymbol.current = id;
      return;
    }
    setLayout((l) => (l.symbol === id ? l : { ...l, symbol: id }));
  }, [setLayout]);

  return { layout, setLayout, selectSymbol, loaded, loadError, retry };
}

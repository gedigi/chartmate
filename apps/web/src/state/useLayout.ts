import type { Layout } from '@altv/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDebouncedSave } from './useDebouncedSave';

export const DEFAULT_LAYOUT: Layout = {
  symbol: 'crypto:BTC',
  tf: '1D',
  session: 'rth',
  chartType: 'candle',
  indicators: [{ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true }],
};

export const symbolLayoutKey = (symbol: string) => `sym:${symbol}`;

/**
 * The current chart layout.
 * - Loads the `default` layout on mount (falls back to DEFAULT_LAYOUT on 404/error).
 * - Whenever the symbol changes, loads `sym:<id>` and, if present, adopts its indicators.
 *   If the user edits indicators on that symbol before the load resolves, their edit wins: the loaded
 *   indicators are not adopted and the edit is written to `sym:<id>` instead.
 * - Saves `default` (whole layout) and `sym:<id>` (for the current symbol) debounced. The per-symbol key is
 *   only written after that symbol's own layout has been loaded, so merely visiting a symbol does not
 *   snapshot the carried-over indicators onto it, and only when the indicators change by value (tf /
 *   chart-type changes do not touch it).
 * Callers should not offer edits until `loaded` is true: the `default` load replaces the whole layout.
 */
export function useLayout(): { layout: Layout; setLayout: (fn: (l: Layout) => Layout) => void; loaded: boolean } {
  const [layout, setLayoutState] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
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
    let cancelled = false;
    api.layouts.get('default').then(
      (l) => { if (!cancelled) { if (l) setLayoutState(l); setLoaded(true); } },
      () => { if (!cancelled) setLoaded(true); },
    );
    return () => { cancelled = true; };
  }, []);

  const symbol = layout.symbol;
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setSymLoadedFor(null);
    symDone.current = null;
    if (editedSym.current !== symbol) editedSym.current = null;
    api.layouts.get(symbolLayoutKey(symbol)).then(
      (l) => {
        if (cancelled) return;
        symDone.current = symbol;
        if (editedSym.current === symbol) {
          editedSym.current = null;
          // Keep the user's edit and persist it under this symbol (the debounced saver treats the value at
          // enable time as the baseline, so it would not write it).
          const cur = layoutRef.current;
          if (cur.symbol === symbol) api.layouts.put(symbolLayoutKey(symbol), cur).catch(() => { /* next edit retries */ });
        } else if (l) {
          setLayoutState((cur) => (cur.symbol === symbol ? { ...cur, indicators: l.indicators } : cur));
        }
        setSymLoadedFor(symbol);
      },
      () => { if (!cancelled) { symDone.current = symbol; editedSym.current = null; setSymLoadedFor(symbol); } },
    );
    return () => { cancelled = true; };
  }, [symbol, loaded]);

  const saveDefault = useCallback((l: Layout) => api.layouts.put('default', l), []);
  const saveSymbol = useCallback((l: Layout) => api.layouts.put(symbolLayoutKey(l.symbol), l), []);
  useDebouncedSave(layout, saveDefault, 1000, loaded);
  // Identity changes only when the symbol or the indicators (by value) change.
  const indicatorsJson = JSON.stringify(layout.indicators);
  // Deliberately keyed on symbol + indicators only (tf/chartType changes must not re-save sym:<id>).
  const symValue = useMemo(() => layout, [symbol, indicatorsJson]);
  useDebouncedSave(symValue, saveSymbol, 1000, loaded && symLoadedFor === symbol);

  const setLayout = useCallback((fn: (l: Layout) => Layout) => setLayoutState((cur) => {
    const next = fn(cur);
    // Idempotent (safe under StrictMode's double-invoked updaters).
    if (loadedRef.current && symDone.current !== cur.symbol && next.symbol === cur.symbol
      && JSON.stringify(next.indicators) !== JSON.stringify(cur.indicators)) {
      editedSym.current = cur.symbol;
    }
    return next;
  }), []);
  return { layout, setLayout, loaded };
}

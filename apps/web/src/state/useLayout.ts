import type { Layout } from '@altv/shared';
import { useCallback, useEffect, useState } from 'react';
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
 * - Saves `default` (whole layout) and `sym:<id>` (for the current symbol) debounced. The per-symbol key is
 *   only written after that symbol's own layout has been loaded, so merely visiting a symbol does not
 *   snapshot the carried-over indicators onto it.
 */
export function useLayout(): { layout: Layout; setLayout: (fn: (l: Layout) => Layout) => void; loaded: boolean } {
  const [layout, setLayoutState] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  /** Symbol whose `sym:` layout has finished loading (null while a load is in flight). */
  const [symLoadedFor, setSymLoadedFor] = useState<string | null>(null);

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
    api.layouts.get(symbolLayoutKey(symbol)).then(
      (l) => {
        if (cancelled) return;
        if (l) setLayoutState((cur) => (cur.symbol === symbol ? { ...cur, indicators: l.indicators } : cur));
        setSymLoadedFor(symbol);
      },
      () => { if (!cancelled) setSymLoadedFor(symbol); },
    );
    return () => { cancelled = true; };
  }, [symbol, loaded]);

  const saveDefault = useCallback((l: Layout) => api.layouts.put('default', l), []);
  const saveSymbol = useCallback((l: Layout) => api.layouts.put(symbolLayoutKey(l.symbol), l), []);
  useDebouncedSave(layout, saveDefault, 1000, loaded);
  useDebouncedSave(layout, saveSymbol, 1000, loaded && symLoadedFor === symbol);

  const setLayout = useCallback((fn: (l: Layout) => Layout) => setLayoutState(fn), []);
  return { layout, setLayout, loaded };
}

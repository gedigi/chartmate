import { migrateAppearance, type Layout, type SymbolId } from '@altv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { COLOR_DEFAULTS_REV, dropLegacyAppearanceDefaults, dropLegacyBarColors } from '../chart/theme';
import { retryDelayMs } from './retry';
import { useDebouncedSave } from './useDebouncedSave';

export const DEFAULT_LAYOUT: Layout = {
  symbol: 'crypto:BTC',
  tf: '1D',
  session: 'rth',
  chartType: 'candle',
  indicators: [{ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true }],
  colorDefaultsRev: COLOR_DEFAULTS_REV,
};

/** A layout saved before appearance was per theme holds the flat shape: it becomes the dark theme's. */
function withThemedAppearance(l: Layout): Layout {
  if (l.appearance === undefined) return l;
  const { appearance, ...rest } = l;
  const themed = migrateAppearance(appearance);
  return themed ? { ...rest, appearance: themed } : rest;
}

/**
 * Colours equal to an earlier release's defaults are read as "default" (see LEGACY_DEFAULTS): the dialogs store
 * the shown default next to the edited field, so those values were not chosen. Every other user colour is kept.
 * Use migrateColorDefaults (runs once per layout); this is the unconditional cleanup it applies.
 */
export function withoutLegacyDefaults(l: Layout): Layout {
  let out = l;
  if (l.appearance) {
    const appearance = { ...l.appearance };
    for (const t of ['dark', 'light'] as const) {
      const a = appearance[t];
      if (!a) continue;
      const clean = dropLegacyAppearanceDefaults(t, a);
      if (clean) appearance[t] = clean;
      else delete appearance[t];
    }
    if (Object.keys(appearance).length > 0) out = { ...out, appearance };
    else {
      const { appearance: _dropped, ...rest } = out;
      out = rest;
    }
  }
  if (l.indicators.some((i) => i.barColors)) {
    out = {
      ...out,
      indicators: l.indicators.map((i) => {
        if (!i.barColors) return i;
        const { barColors, ...rest } = i;
        const clean = dropLegacyBarColors(barColors);
        return clean ? { ...rest, barColors: clean } : rest;
      }),
    };
  }
  return out;
}

/**
 * One-time colour migration: a layout saved under an older COLOR_DEFAULTS_REV gets its old-default colours unset
 * and is stamped with the current revision; a layout already at (or past) it is returned unchanged (same object),
 * so a colour picked later — even one equal to an old default — is never touched again.
 */
export function migrateColorDefaults(l: Layout): Layout {
  if ((l.colorDefaultsRev ?? 0) >= COLOR_DEFAULTS_REV) return l;
  return { ...withoutLegacyDefaults(l), colorDefaultsRev: COLOR_DEFAULTS_REV };
}

export interface UseLayout {
  layout: Layout;
  /** Ignored until `loaded` (the `default` load replaces the whole layout). */
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Switches the symbol; before `loaded` the choice is queued and applied on top of the loaded layout. */
  selectSymbol: (id: SymbolId) => void;
  loaded: boolean;
  /** Set while the `default` layout cannot be loaded (other than a missing one); it is retried with backoff. */
  loadError: string | null;
  /** Retries the `default` load now. */
  retry: () => void;
  /** Set while the latest layout change could not be saved (it is retried with backoff). */
  saveError: string | null;
}

/**
 * The current chart layout, stored under the single `default` key.
 * - Indicators (like appearance) are one global set shared by every symbol: switching symbols keeps them.
 *   Legacy per-symbol `sym:<id>` rows are ignored (never read, written or deleted).
 * - Loads `default` on mount. Only a missing layout (null) falls back to DEFAULT_LAYOUT; any other failure keeps
 *   `loaded` false (so nothing is saved over the user's layout), exposes `loadError` and retries with backoff.
 * - Saves `default` debounced once loaded; a failed save is retried with backoff and exposed as `saveError`.
 * Callers should not offer edits until `loaded` is true: the `default` load replaces the whole layout.
 */
export function useLayout(): UseLayout {
  const [layout, setLayoutState] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  /** Symbol chosen before the default layout loaded; applied right after. */
  const queuedSymbol = useRef<SymbolId | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    if (loadedRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.layouts.get('default').then(
        (l) => {
          if (cancelled) return;
          if (l) {
            const themed = withThemedAppearance(l);
            const migrated = migrateColorDefaults(themed);
            setLayoutState(migrated);
            // The loaded value is the save baseline (not saved): persist the one-time colour migration explicitly.
            // On failure the next layout change saves it (the revision is in the state).
            if (migrated !== themed) api.layouts.put('default', migrated).catch(() => {});
          } // null = nothing saved yet → DEFAULT_LAYOUT
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

  const saveDefault = useCallback((l: Layout) => api.layouts.put('default', l), []);
  const { error: saveError } = useDebouncedSave(layout, saveDefault, 1000, loaded, { retry: true });

  const setLayout = useCallback((fn: (l: Layout) => Layout) => setLayoutState((cur) => {
    if (!loadedRef.current) return cur; // the default load would overwrite it (and saves are off): ignore
    return fn(cur);
  }), []);
  const selectSymbol = useCallback((id: SymbolId) => {
    if (!loadedRef.current) {
      queuedSymbol.current = id;
      return;
    }
    setLayout((l) => (l.symbol === id ? l : { ...l, symbol: id }));
  }, [setLayout]);

  return { layout, setLayout, selectSymbol, loaded, loadError, retry, saveError };
}

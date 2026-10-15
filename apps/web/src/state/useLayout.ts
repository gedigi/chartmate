import { HEX_COLOR_RE, migrateAppearance, type IndicatorState, type Layout, type SymbolId } from '@chartmate/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { catalogEntry, migrateLegacyLineColors, validateParam } from '../chart/indicators/catalog';
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

/** One stored indicator with invalid values replaced (see sanitizeIndicators); the same object when all are valid. */
function sanitizeIndicator(s: IndicatorState): IndicatorState {
  const entry = catalogEntry(s.name);
  const calcParams = entry
    ? s.calcParams.map((v, i) => (validateParam(s.name, i, String(v)) === null ? v : entry.defaultParams[i] ?? v))
      .filter((v) => Number.isFinite(v))
    : s.calcParams.filter((v) => Number.isFinite(v));
  const paramsChanged = calcParams.length !== s.calcParams.length || calcParams.some((v, i) => v !== s.calcParams[i]);
  const lineColors = s.lineColors?.map((c) => (c === '' || HEX_COLOR_RE.test(c) ? c : ''));
  const colorsChanged = lineColors !== undefined && lineColors.some((c, i) => c !== s.lineColors![i]);
  if (!paramsChanged && !colorsChanged) return s;
  const out: IndicatorState = { ...s, calcParams };
  if (colorsChanged) {
    while (lineColors.length > 0 && lineColors[lineColors.length - 1] === '') lineColors.pop();
    if (lineColors.length > 0) out.lineColors = lineColors;
    else delete out.lineColors;
  }
  return out;
}

/**
 * Stored indicator values are checked on read (the server only checks their types): a param the settings dialog would
 * reject (not finite, out of the catalog's bounds) becomes the catalog default, a line color that is not '#rrggbb'
 * follows the theme again. Returns `l` itself when everything is valid.
 */
export function sanitizeIndicators(l: Layout): Layout {
  const indicators = l.indicators.map(sanitizeIndicator);
  return indicators.some((s, i) => s !== l.indicators[i]) ? { ...l, indicators } : l;
}

/**
 * Colors equal to an earlier release's defaults are read as "default" (see LEGACY_DEFAULTS): the dialogs store
 * the shown default next to the edited field, so those values were not chosen. Every other user color is kept.
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
  if (l.indicators.some((i) => i.barColors || i.lineColors)) {
    out = {
      ...out,
      indicators: l.indicators.map((i) => {
        let next = i;
        if (next.barColors) {
          const { barColors, ...rest } = next;
          const clean = dropLegacyBarColors(barColors);
          next = clean ? { ...rest, barColors: clean } : rest;
        }
        if (next.lineColors) {
          const { lineColors, ...rest } = next;
          const migrated = migrateLegacyLineColors(next.name, lineColors);
          next = migrated ? { ...rest, lineColors: migrated } : rest;
        }
        return next;
      }),
    };
  }
  return out;
}

/**
 * One-time color migration: a layout saved under an older COLOR_DEFAULTS_REV gets its old-default colors unset
 * and is stamped with the current revision; a layout already at (or past) it is returned unchanged (same object),
 * so a color picked later — even one equal to an old default — is never touched again.
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
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api.layouts.get('default').then(
        (l) => {
          if (canceled) return;
          if (l) {
            const themed = sanitizeIndicators(withThemedAppearance(l));
            const migrated = migrateColorDefaults(themed);
            setLayoutState(migrated);
            // The loaded value is the save baseline (not saved): persist the one-time color migration explicitly.
            // On failure the next layout change saves it (the revision is in the state).
            if (migrated !== themed) api.layouts.put('default', migrated).catch(() => {});
          } // null = nothing saved yet → DEFAULT_LAYOUT
          setLoadError(null);
          setLoaded(true);
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

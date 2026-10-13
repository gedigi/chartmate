import { isIntraday, parseSymbolId, type DrawingState, type IndicatorState, type Layout, type SymbolId, type SymbolInfo } from '@chartmate/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { api, errorMessage } from '../api/client';
import { ChartAdapter, type IndicatorSpec } from '../chart/ChartAdapter';
import { migrateCalcParams } from '../chart/indicators/catalog';
import type { LoaderMeta } from '../chart/dataLoader';
import { pollIntervalMs } from '../chart/periods';
import { onBasketChanged } from '../state/useBaskets';
import { useDebouncedSave } from '../state/useDebouncedSave';
import { retryDelayMs } from '../state/retry';
import { DrawingStyleBar } from './DrawingStyleBar';
import { DrawingToolbar } from './DrawingToolbar';
import { IndicatorChips } from './IndicatorChips';
import { StaleBadge } from './StaleBadge';
import './ChartView.css';

export interface ChartViewProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Null while the symbol's info is loading or failed to load. */
  symbolInfo: SymbolInfo | null;
  /** Set when the current symbol's info failed to load (an error panel with Retry replaces the chart). */
  symbolError?: string | null;
  /** Retry button of the symbol error panel. */
  onRetrySymbol?: () => void;
  theme: 'dark' | 'light';
}

const EMPTY_META: LoaderMeta = { stale: false, notices: [], markers: [] };
const TOAST_MS = 6000;
const DRAWINGS_SAVE_MS = 1000;

/**
 * Polling interval for a symbol; baskets poll fast only if they contain crypto (re-checked when the basket is
 * edited). Null while unknown. `basketHasCrypto` also tells the chart that the basket uses the UTC bar grid.
 */
function usePollMs(info: SymbolInfo | null): { pollMs: number | null; basketHasCrypto: boolean } {
  const [basket, setBasket] = useState<{ id: SymbolId; crypto: boolean } | null>(null);
  const [basketRev, setBasketRev] = useState(0);
  const isBasket = info?.assetClass === 'basket';
  const id = info?.id;
  useEffect(() => {
    if (!isBasket || !id) return;
    const code = parseSymbolId(id).code;
    return onBasketChanged((changed) => { if (changed === code) setBasketRev((r) => r + 1); });
  }, [isBasket, id]);
  useEffect(() => {
    if (!isBasket || !id) return;
    let canceled = false;
    const done = (crypto: boolean) => { if (!canceled) setBasket({ id, crypto }); };
    api.baskets.get(parseSymbolId(id).code).then(
      (b) => done(b.versions.some((v) => Object.keys(v.weights).some((w) => w.startsWith('crypto:')))),
      () => done(false),
    );
    return () => { canceled = true; };
  }, [isBasket, id, basketRev]);
  if (!info) return { pollMs: null, basketHasCrypto: false };
  if (!isBasket) return { pollMs: pollIntervalMs(info.assetClass), basketHasCrypto: false };
  if (basket?.id !== info.id) return { pollMs: null, basketHasCrypto: false };
  return { pollMs: pollIntervalMs(basket.crypto ? 'crypto' : 'basket'), basketHasCrypto: basket.crypto };
}

/** The indicator's style overrides (absent = default). */
function styleOverrides(s: IndicatorState): Partial<IndicatorSpec> {
  const o: Partial<IndicatorSpec> = {};
  if (s.lineColors) o.lineColors = s.lineColors;
  if (s.lineWidths) o.lineWidths = s.lineWidths;
  if (s.lineStyles) o.lineStyles = s.lineStyles;
  if (s.barColors) o.barColors = s.barColors;
  return o;
}

/** Chart spec of a stored indicator; stored params go through the same migration as the settings dialog. */
function toSpec(s: IndicatorState): IndicatorSpec {
  return { name: s.name, pane: s.pane, calcParams: migrateCalcParams(s.name, s.calcParams), visible: s.visible, ...styleOverrides(s) };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Owns the whole chart region: the left drawing-toolbar column and the chart area (with indicator chips,
 * stale badge, etc.). The root fills its grid cell; `.chart-view` is itself a 2-column grid.
 * One ChartAdapter lives for the component's lifetime and is driven from `layout`.
 */
export function ChartView({ layout, setLayout, symbolInfo, symbolError = null, onRetrySymbol, theme }: ChartViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<ChartAdapter | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [meta, setMeta] = useState<LoaderMeta>(EMPTY_META);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  /** First data (or a definitive failure) of the current load is in; until then a loading overlay shows. */
  const [dataSettled, setDataSettled] = useState(false);
  const [dataReceived, setDataReceived] = useState(false);
  /** Error message while initial loads / polls keep failing (one persistent banner instead of toasts). */
  const [connectionLost, setConnectionLost] = useState<string | null>(null);
  /** The current load failed permanently (e.g. a 4xx): shown inline with Retry; nothing retries on its own. */
  const [loadFatal, setLoadFatal] = useState<string | null>(null);
  /** Bumped by that Retry button to run the load again. */
  const [reloadKey, setReloadKey] = useState(0);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const indicatorsRef = useRef(new Map<string, { id: string; state: IndicatorState }>());

  const info = symbolInfo && symbolInfo.id === layout.symbol ? symbolInfo : null;
  const { pollMs, basketHasCrypto } = usePollMs(info);
  const { symbol, tf, session, chartType, indicators } = layout;

  // Adapter lifetime + resize.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let a: ChartAdapter;
    try {
      a = new ChartAdapter(el, { theme: themeRef.current });
    } catch (err) {
      setInitError(errorMessage(err));
      return;
    }
    setAdapter(a);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => a.resize());
    ro?.observe(el);
    const indicatorMap = indicatorsRef.current;
    return () => {
      ro?.disconnect();
      a.destroy();
      indicatorMap.clear();
      setAdapter(null);
    };
  }, []);

  useEffect(() => { adapter?.setTheme(theme); }, [adapter, theme]);
  useEffect(() => { adapter?.setChartType(chartType); }, [adapter, chartType]);
  // Global appearance (candle colors, line width, default drawing style); re-applied only on a change by value.
  const appearanceJson = JSON.stringify(layout.appearance ?? null);
  useEffect(() => {
    adapter?.setAppearance(JSON.parse(appearanceJson) ?? undefined);
  }, [adapter, appearanceJson]);
  // Risk defaults of new long / short positions (global, like the appearance).
  const positionDefaultsJson = JSON.stringify(layout.positionDefaults ?? null);
  useEffect(() => {
    adapter?.setPositionDefaults(JSON.parse(positionDefaultsJson) ?? undefined);
  }, [adapter, positionDefaultsJson]);

  // Data: (re)load on symbol / timeframe / session change. Without info for the current symbol (loading or
  // failed) the chart is blanked and the previous symbol's loader stops: its data must not sit under the new header.
  useEffect(() => {
    if (!adapter) return;
    setMeta(EMPTY_META);
    setDismissed(new Set());
    setToast(null);
    setConnectionLost(null);
    setLoadFatal(null);
    setDataSettled(false);
    setDataReceived(false);
    if (!info || pollMs === null) {
      adapter.clear();
      return;
    }
    let active = true;
    adapter.load(info.assetClass === 'basket' ? { symbol: info, tf, session, pollMs, basketHasCrypto } : { symbol: info, tf, session, pollMs }, {
      onMeta: (m) => {
        if (!active) return;
        setMeta(m);
        setDataSettled(true);
        setDataReceived(true);
      },
      onError: (e) => { if (active) setToast(errorMessage(e)); },
      onConnection: (lost, e) => {
        if (!active) return;
        setConnectionLost(lost ? errorMessage(e ?? new Error('Connection lost')) : null);
        if (lost) setDataSettled(true);
      },
      onFatal: (e) => {
        if (!active) return;
        setConnectionLost(null);
        setLoadFatal(errorMessage(e));
        setDataSettled(true);
      },
    });
    return () => { active = false; };
  }, [adapter, info, tf, session, pollMs, basketHasCrypto, reloadKey]);

  const shade = session === 'eth' && isIntraday(tf) && info?.assetClass === 'stock'; // only stock bars carry session tags
  useEffect(() => { adapter?.setSessionShading(shade); }, [adapter, shade]);
  useEffect(() => { adapter?.setMarkers(meta.markers); }, [adapter, meta.markers]);

  // Indicators: diff by name + pane + index.
  useEffect(() => {
    if (!adapter) return;
    const current = indicatorsRef.current;
    const desired = new Map<string, IndicatorState>(indicators.map((s, i) => [`${s.name}|${s.pane}|${i}`, s]));
    for (const [key, { id }] of current) {
      if (!desired.has(key)) {
        adapter.removeIndicator(id);
        current.delete(key);
      }
    }
    for (const [key, s] of desired) {
      const cur = current.get(key);
      if (!cur) {
        try {
          current.set(key, { id: adapter.addIndicator(toSpec(s)), state: s });
        } catch (err) {
          setToast(errorMessage(err));
        }
      } else if (cur.state !== s && !sameJson(toSpec(cur.state), toSpec(s))) {
        const spec = toSpec(s);
        const update: Partial<IndicatorSpec> = { calcParams: spec.calcParams, visible: spec.visible, ...styleOverrides(s) };
        adapter.updateIndicator(cur.id, update);
        current.set(key, { id: cur.id, state: s });
      } else {
        current.set(key, { id: cur.id, state: s });
      }
    }
  }, [adapter, indicators]);

  // Drawings: restore per symbol; save debounced after user edits (only once the symbol's drawings loaded).
  const [drawingsFor, setDrawingsFor] = useState<SymbolId | null>(null);
  const [drawingsValue, setDrawingsValue] = useState<{ symbol: SymbolId; drawings: DrawingState[] } | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const drawingsForRef = useRef(drawingsFor);
  drawingsForRef.current = drawingsFor;

  useEffect(() => {
    if (!adapter) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDrawingsFor(null);
    adapter.restoreDrawings([]);
    // Retried with backoff: saving stays disabled until this symbol's drawings are loaded.
    const fetchDrawings = (attempt: number) => {
      api.drawings.get(symbol).then(
        (d) => {
          if (canceled) return;
          adapter.restoreDrawings(d, symbol); // created once this symbol's data is in
          setDrawingsFor(symbol);
        },
        (err: unknown) => {
          if (canceled) return;
          if (attempt === 0) setToast(`Could not load drawings (retrying): ${errorMessage(err)}`);
          timer = setTimeout(() => fetchDrawings(attempt + 1), retryDelayMs(attempt));
        },
      );
    };
    fetchDrawings(0);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [adapter, symbol]);

  useEffect(() => adapter?.onDrawingsChange(() => {
    const s = symbolRef.current;
    if (drawingsForRef.current !== s) return; // never overwrite drawings we have not loaded
    setDrawingsValue({ symbol: s, drawings: adapter.serializeDrawings() });
  }), [adapter]);

  // Enabled only while the current symbol's drawings are loaded: a symbol switch disables it in the same
  // render, which flushes the previous symbol's pending save immediately instead of losing it.
  const { error: saveError } = useDebouncedSave(
    drawingsValue,
    (v) => (v ? api.drawings.put(v.symbol, v.drawings) : Promise.resolve()),
    DRAWINGS_SAVE_MS,
    drawingsFor === symbol,
  );
  useEffect(() => { if (saveError) setToast(`Could not save drawings: ${saveError}`); }, [saveError]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const notices = meta.notices.filter((n) => !dismissed.has(n));
  const symbolFailed = !initError && symbolError !== null && !info;
  // Drawing tools only once this symbol's drawings are loaded and the chart has data (or gave up waiting for it),
  // so nothing drawn in the switch window is lost to a pending restore.
  const drawingReady = drawingsFor === symbol && dataSettled && info !== null;

  return (
    <div className="chart-view" data-testid="chart-view">
      <div className="left-toolbar">
        <DrawingToolbar controls={adapter} disabled={!drawingReady} ticker={info?.ticker ?? symbol} />
      </div>
      <div className="chart-area">
        <IndicatorChips layout={layout} setLayout={setLayout} theme={theme} />
        <div className="chart-stage">
          <div className="chart-host" ref={hostRef} data-testid="chart-host" />
          <DrawingStyleBar controls={adapter} onUsePositionDefaults={(positionDefaults) => setLayout((l) => ({ ...l, positionDefaults }))} />
          {initError && <div className="center-message chart-init-error" role="alert">Chart failed to start: {initError}</div>}
          {symbolFailed && (
            <div className="center-message chart-error-panel" role="alert" data-testid="symbol-error">
              <p>Couldn&apos;t load symbol {symbol}: {symbolError}</p>
              <button type="button" onClick={onRetrySymbol}>Retry</button>
            </div>
          )}
          {!initError && !symbolFailed && loadFatal !== null && (
            <div className="center-message chart-error-panel" role="alert" data-testid="load-error">
              <p>Couldn&apos;t load {info?.ticker ?? symbol}: {loadFatal}</p>
              <button type="button" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
            </div>
          )}
          {!initError && !symbolFailed && loadFatal === null && !dataReceived && (
            <div className="chart-loading" data-testid="chart-loading" aria-live="polite">Loading…</div>
          )}
          <div className="chart-overlay-bottom-left">
            {connectionLost !== null && (
              <div className="chart-banner" role="status" title={connectionLost}>Connection lost — retrying…</div>
            )}
            <StaleBadge stale={meta.stale || connectionLost !== null} />
            {notices.map((n) => (
              <div key={n} className="chart-notice">
                <span>{n}</span>
                <button
                  type="button"
                  className="chart-notice-dismiss"
                  aria-label="Dismiss notice"
                  onClick={() => setDismissed((d) => new Set(d).add(n))}
                >×</button>
              </div>
            ))}
          </div>
          {toast && (
            <div className="chart-toast" role="alert">
              <span>{toast}</span>
              <button type="button" className="chart-notice-dismiss" aria-label="Dismiss error" onClick={() => setToast(null)}>×</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

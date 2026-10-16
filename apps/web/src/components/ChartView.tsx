import { isIntraday, parseSymbolId, type DrawingState, type IndicatorState, type Layout, type SessionMode, type SymbolId, type SymbolInfo, type Timeframe } from '@chartmate/shared';
import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, errorMessage, isPermanentError } from '../api/client';
import { ChartAdapter, type IndicatorSpec, type ShownRange } from '../chart/ChartAdapter';
import { migrateCalcParams } from '../chart/indicators/catalog';
import type { LoaderMeta } from '../chart/dataLoader';
import { initialWindowMs, pollIntervalMs } from '../chart/periods';
import { allTimeframe, rangeTimeframe, type RangeCalendar, type RangePreset } from '../chart/ranges';
import { onBasketChanged } from '../state/useBaskets';
import { drawingsStore } from '../state/drawingsStore';
import { DrawingsNote } from './DrawingsSave';
import { SaveNote, type SaveNoteState } from './SaveNote';
import { loadWithRetry, retryDelayMs } from '../state/retry';
import { scrollFade, useScrollEdges } from '../state/useScrollEdges';
import { DrawingStyleBar } from './DrawingStyleBar';
import { DrawingToolbar } from './DrawingToolbar';
import { IndicatorChips } from './IndicatorChips';
import { RangeBar } from './RangeBar';
import { StaleBadge } from './StaleBadge';
import './ChartView.css';

export interface ChartViewProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Null while the symbol's info is loading or failed to load. */
  symbolInfo: SymbolInfo | null;
  /** Set when the current symbol's info failed to load (an error panel with Retry replaces the chart). */
  symbolError?: string | null;
  /** The symbol is a basket that no longer exists (its info load failed with 404). */
  symbolDeleted?: boolean;
  /** The layout's unsaved state, shown in the chart's note stack (with unsaved drawings); null when saved. */
  layoutSaveNote?: { state: SaveNoteState; detail: string; onRetry: () => void } | null;
  /** Retry button of the symbol error panel. */
  onRetrySymbol?: () => void;
  theme: 'dark' | 'light';
}

const EMPTY_META: LoaderMeta = { stale: false, notices: [], markers: [] };
const TOAST_MS = 6000;

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
    // A failed lookup charts it as stock-only for now (so the chart still loads) and is retried unless permanent.
    return loadWithRetry(
      () => api.baskets.get(parseSymbolId(id).code),
      (b) => setBasket({ id, crypto: b.versions.some((v) => Object.keys(v.weights).some((w) => w.startsWith('crypto:'))) }),
      () => setBasket((prev) => (prev?.id === id ? prev : { id, crypto: false })),
    );
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
  if (s.levels) o.levels = s.levels;
  if (s.showLevels === false) o.showLevels = false;
  return o;
}

/** Chart spec of a stored indicator; stored params go through the same migration as the settings dialog. */
function toSpec(s: IndicatorState): IndicatorSpec {
  return { name: s.name, pane: s.pane, calcParams: migrateCalcParams(s.name, s.calcParams), visible: s.visible, ...styleOverrides(s) };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A date range picked in the range bar, for the symbol / interval / session it was shown on. */
interface ActiveRange { preset: RangePreset; symbol: SymbolId; tf: Timeframe; session: SessionMode; calendar: RangeCalendar }

/**
 * Owns the whole chart region: the left drawing-toolbar column and the chart area (with indicator chips,
 * stale badge, etc.). The root fills its grid cell; `.chart-view` is itself a 2-column grid.
 * One ChartAdapter lives for the component's lifetime and is driven from `layout`.
 */
function ChartViewPanel({ layout, setLayout, symbolInfo, symbolError = null, symbolDeleted = false, layoutSaveNote = null, onRetrySymbol, theme }: ChartViewProps): JSX.Element {
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
  const [range, setRange] = useState<ActiveRange | null>(null);
  /** Bumped by each range pick and by symbol / interval / session changes: a pending All probe then gives up. */
  const rangeSeq = useRef(0);
  /** The pending All history lookup: aborted by the next pick, a symbol / interval / session change or unmounting. */
  const allLookup = useRef<AbortController | null>(null);
  /** The symbol whose data has arrived at least once: until then the range row is disabled (not on every reload). */
  const [dataFor, setDataFor] = useState<SymbolId | null>(null);

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
  // Color of new drawings: the last swatch picked in the style bar (global, like the appearance).
  useEffect(() => {
    adapter?.setNewDrawingColor(layout.drawingColor);
  }, [adapter, layout.drawingColor]);

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
        setDataFor(info.id);
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

  // Date ranges: shown once the range's interval is loaded (declared after the load effect, which drops the adapter's
  // range: a reload of the same interval, e.g. Retry, shows it again). Changing the symbol, interval or session, or
  // zooming / scrolling the chart, deselects it.
  useEffect(() => {
    if (!adapter || !range || info?.id !== range.symbol || range.tf !== tf || range.session !== session || pollMs === null) return;
    adapter.showRange(range.preset, range.calendar);
  }, [adapter, range, info, tf, session, pollMs, basketHasCrypto, reloadKey]);
  useEffect(() => {
    rangeSeq.current++;
    allLookup.current?.abort();
    setRange((r) => (r && (r.symbol !== symbol || r.tf !== tf || r.session !== session) ? null : r));
  }, [symbol, tf, session]);
  useEffect(() => () => {
    rangeSeq.current++;
    allLookup.current?.abort();
  }, []);
  useEffect(() => adapter?.onRangeCanceled(() => setRange(null)), [adapter]);
  const [shown, setShown] = useState<ShownRange | null>(null);
  useEffect(() => adapter?.onRangeShown(setShown), [adapter]);
  const calendar: RangeCalendar = info?.assetClass === 'crypto' || basketHasCrypto ? 'crypto' : 'stock';
  const selectRange = useCallback((preset: RangePreset) => {
    if (!adapter || !info) return;
    const seq = ++rangeSeq.current;
    allLookup.current?.abort(); // a newer pick wins over a pending All
    const show = (rangeTf: Timeframe) => {
      if (seq !== rangeSeq.current) return; // superseded while All looked up the history
      setRange({ preset, symbol: info.id, tf: rangeTf, session, calendar });
      setLayout((l) => (l.tf === rangeTf ? l : { ...l, tf: rangeTf }));
    };
    if (preset !== 'All') {
      show(rangeTimeframe(preset));
      return;
    }
    // All: weekly bars, or monthly ones when the weekly history would not fit the chart (one monthly page tells).
    const now = Date.now();
    const lookup = new AbortController();
    allLookup.current = lookup;
    api.bars({ symbol: info.id, tf: '1M', session, from: now - initialWindowMs('1M'), to: now }, lookup.signal).then(
      (r) => {
        if (lookup.signal.aborted) return;
        show(rangeTimeframe('All', allTimeframe(r.hasMoreBefore ? 0 : (r.bars[0]?.ts ?? null), r.bars.at(-1)?.ts ?? now, adapter.plotWidth())));
      },
      () => { if (!lookup.signal.aborted) show(rangeTimeframe('All')); },
    ).finally(() => { if (allLookup.current === lookup) allLookup.current = null; });
  }, [adapter, info, session, calendar, setLayout]);
  const [bottomRowRef, bottomRowEdges] = useScrollEdges();
  const activeRange = range && range.symbol === symbol && range.tf === tf && range.session === session ? range.preset : null;
  const rangeSpan = activeRange !== null && shown?.preset === activeRange ? shown.label : '';

  const shade = session === 'eth' && isIntraday(tf) && info?.assetClass === 'stock'; // only stock bars carry session tags
  useEffect(() => { adapter?.setSessionShading(shade); }, [adapter, shade]);
  useEffect(() => { adapter?.setMarkers(meta.markers); }, [adapter, meta.markers]);

  // Indicators: diff by name + pane + occurrence (the n-th RSI on a sub pane), so removing one leaves the others'
  // chart indicators (and their pane heights) alone; only later indicators of the same kind shift onto the earlier
  // one's chart indicator (updated in place).
  useEffect(() => {
    if (!adapter) return;
    const current = indicatorsRef.current;
    const seen = new Map<string, number>();
    const desired = new Map<string, IndicatorState>(indicators.map((s) => {
      const kind = `${s.name}|${s.pane}`;
      const n = seen.get(kind) ?? 0;
      seen.set(kind, n + 1);
      return [`${kind}|${n}`, s];
    }));
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
  // Saving goes through the drawings store (savers mounted by the app shell, see DrawingsSave): this symbol takes new
  // values only while its drawings are loaded. A symbol switch (or leaving the chart view) makes it inactive in the
  // same commit, which flushes its pending save at once and keeps retrying it.
  const activeDrawings = drawingsFor === symbol ? symbol : null;
  useEffect(() => { drawingsStore.setActive(activeDrawings); }, [activeDrawings]);
  useEffect(() => () => drawingsStore.setActive(null), []);
  useEffect(() => { if (info) drawingsStore.setTicker(info.id, info.ticker); }, [info]);
  // Discarding the charted symbol's rejected drawings: show the server's drawings again.
  const [drawingsReload, setDrawingsReload] = useState(0);
  useEffect(() => drawingsStore.onDiscard((s) => { if (s === symbolRef.current) setDrawingsReload((k) => k + 1); }), []);
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
    // Drawings of this symbol that have not reached the server yet (a save still retrying, stalled or failed) are
    // restored from memory instead of the server's copy. Last writer wins: this tab's unsaved drawings replace whatever
    // another tab saved meanwhile once they are saved (drawings are stored as one list per symbol, no merge).
    const local = drawingsStore.getSnapshot().values.get(symbol);
    if (local) {
      adapter.restoreDrawings(local, symbol);
      setDrawingsFor(symbol);
      return;
    }
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
          // A permanent failure cannot succeed later: say so once; drawing stays off so nothing overwrites them.
          if (isPermanentError(err)) {
            setToast(`Could not load drawings: ${errorMessage(err)}`);
            return;
          }
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
  }, [adapter, symbol, drawingsReload]);

  // A finished Shift measure, read out to screen readers (the chart itself is a canvas).
  const [measureText, setMeasureText] = useState('');
  useEffect(() => {
    setMeasureText('');
    return adapter?.onMeasureChange((m) => setMeasureText(m ? `Measure: ${m.lines.join(', ')}` : ''));
  }, [adapter]);

  useEffect(() => adapter?.onDrawingsChange(() => {
    const s = symbolRef.current;
    if (drawingsForRef.current !== s) return; // never overwrite drawings we have not loaded
    drawingsStore.setValue(s, adapter.serializeDrawings());
  }), [adapter]);


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
        {/* Top row, outside the plot: the indicator chips (hidden while the symbol failed: they belong to a chart) and,
            on the right, the stack of chart-level save notes (layout, then each symbol's unsaved drawings). */}
        <div className="chart-toprow">
          {!symbolFailed && <IndicatorChips layout={layout} setLayout={setLayout} theme={theme} />}
          <div className="chart-save-notes">
            {layoutSaveNote && (
              <SaveNote thing="Layout" state={layoutSaveNote.state} detail={layoutSaveNote.detail} retryLabel="Retry saving the layout"
                onRetry={layoutSaveNote.onRetry} />
            )}
            <DrawingsNote />
          </div>
        </div>
        <div className="chart-stage">
          <div className="chart-host" ref={hostRef} data-testid="chart-host" />
          <div className="sr-only" role="status" data-testid="measure-readout">{measureText}</div>
          <DrawingStyleBar
            controls={adapter} onUsePositionDefaults={(positionDefaults) => setLayout((l) => ({ ...l, positionDefaults }))}
            onPickColor={(drawingColor) => setLayout((l) => (l.drawingColor === drawingColor ? l : { ...l, drawingColor }))}
            onResetColor={() => setLayout(({ drawingColor: _reset, ...l }) => l)}
          />
          {initError && <div className="center-message chart-init-error" role="alert">Chart failed to start: {initError}</div>}
          {symbolFailed && symbolDeleted && (
            <div className="center-message chart-deleted-panel" data-testid="symbol-deleted">
              <p className="chart-deleted-title">Deleted basket</p>
              <p className="chart-deleted-hint">This basket no longer exists. Pick another symbol in the watchlist or search.</p>
            </div>
          )}
          {symbolFailed && !symbolDeleted && (
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
        {/* Bottom row, under the time axis (in flow, like the top row: it never covers plot data). */}
        {/* Scrolls sideways on a narrow chart, its hidden edge(s) faded. Enabled once the symbol has data (not on each
            reload: a range switching the interval must not take the focus away from its button). */}
        <div className="chart-bottomrow" ref={bottomRowRef} data-fade={scrollFade(bottomRowEdges)}>
          <RangeBar value={activeRange} onSelect={selectRange} disabled={!info || pollMs === null || dataFor !== symbol || symbolFailed} />
          <span className="range-span" role="status" data-testid="range-span">{rangeSpan}</span>
        </div>
      </div>
    </div>
  );
}

/** Memoized: resizing the sidebar re-renders the shell, not this. */
export const ChartView = memo(ChartViewPanel);

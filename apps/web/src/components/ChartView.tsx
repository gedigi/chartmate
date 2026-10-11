import { isIntraday, parseSymbolId, type DrawingState, type IndicatorState, type Layout, type SymbolId, type SymbolInfo } from '@altv/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { api, errorMessage } from '../api/client';
import { ChartAdapter, type IndicatorSpec } from '../chart/ChartAdapter';
import type { LoaderMeta } from '../chart/dataLoader';
import { pollIntervalMs } from '../chart/periods';
import { useDebouncedSave } from '../state/useDebouncedSave';
import { StaleBadge } from './StaleBadge';
import './ChartView.css';

export interface ChartViewProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Null while the symbol's info is loading or failed to load. */
  symbolInfo: SymbolInfo | null;
  theme: 'dark' | 'light';
}

const EMPTY_META: LoaderMeta = { stale: false, notices: [], markers: [] };
const TOAST_MS = 6000;
const DRAWINGS_SAVE_MS = 1000;

/** Polling interval for a symbol; baskets poll fast only if they contain crypto. Null while unknown. */
function usePollMs(info: SymbolInfo | null): number | null {
  const [basket, setBasket] = useState<{ id: SymbolId; ms: number } | null>(null);
  const isBasket = info?.assetClass === 'basket';
  const id = info?.id;
  useEffect(() => {
    if (!isBasket || !id) return;
    let cancelled = false;
    const done = (ms: number) => { if (!cancelled) setBasket({ id, ms }); };
    api.baskets.get(parseSymbolId(id).code).then(
      (b) => done(pollIntervalMs(b.versions.some((v) => Object.keys(v.weights).some((w) => w.startsWith('crypto:'))) ? 'crypto' : 'basket')),
      () => done(pollIntervalMs('basket')),
    );
    return () => { cancelled = true; };
  }, [isBasket, id]);
  if (!info) return null;
  if (!isBasket) return pollIntervalMs(info.assetClass);
  return basket?.id === info.id ? basket.ms : null;
}

function toSpec(s: IndicatorState): IndicatorSpec {
  const spec: IndicatorSpec = { name: s.name, pane: s.pane, calcParams: s.calcParams, visible: s.visible };
  if (s.lineColors) spec.lineColors = s.lineColors;
  return spec;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Owns the whole chart region: the left drawing-toolbar column and the chart area (with indicator chips,
 * stale badge, etc.). The root fills its grid cell; `.chart-view` is itself a 2-column grid.
 * One ChartAdapter lives for the component's lifetime and is driven from `layout`.
 */
export function ChartView({ layout, symbolInfo, theme }: ChartViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<ChartAdapter | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [meta, setMeta] = useState<LoaderMeta>(EMPTY_META);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const indicatorsRef = useRef(new Map<string, { id: string; state: IndicatorState }>());

  const info = symbolInfo && symbolInfo.id === layout.symbol ? symbolInfo : null;
  const pollMs = usePollMs(info);
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

  // Data: (re)load on symbol / timeframe / session change.
  useEffect(() => {
    if (!adapter || !info || pollMs === null) return;
    let active = true;
    setMeta(EMPTY_META);
    setDismissed(new Set());
    setToast(null);
    adapter.load({ symbol: info, tf, session, pollMs }, {
      onMeta: (m) => { if (active) setMeta(m); },
      onError: (e) => { if (active) setToast(errorMessage(e)); },
    });
    return () => { active = false; };
  }, [adapter, info, tf, session, pollMs]);

  const shade = session === 'eth' && isIntraday(tf) && info?.assetClass !== 'crypto';
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
        const update: Partial<IndicatorSpec> = { calcParams: s.calcParams, visible: s.visible };
        if (s.lineColors) update.lineColors = s.lineColors;
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
    let cancelled = false;
    setDrawingsFor(null);
    adapter.restoreDrawings([]);
    api.drawings.get(symbol).then(
      (d) => {
        if (cancelled) return;
        adapter.restoreDrawings(d);
        setDrawingsFor(symbol);
      },
      (err: unknown) => { if (!cancelled) setToast(`Could not load drawings: ${errorMessage(err)}`); },
    );
    return () => { cancelled = true; };
  }, [adapter, symbol]);

  useEffect(() => adapter?.onDrawingsChange(() => {
    const s = symbolRef.current;
    if (drawingsForRef.current !== s) return; // never overwrite drawings we have not loaded
    setDrawingsValue({ symbol: s, drawings: adapter.serializeDrawings() });
  }), [adapter]);

  const { error: saveError } = useDebouncedSave(
    drawingsValue,
    (v) => (v ? api.drawings.put(v.symbol, v.drawings) : Promise.resolve()),
    DRAWINGS_SAVE_MS,
  );
  useEffect(() => { if (saveError) setToast(`Could not save drawings: ${saveError}`); }, [saveError]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const notices = meta.notices.filter((n) => !dismissed.has(n));

  return (
    <div className="chart-view" data-testid="chart-view">
      <div className="left-toolbar" aria-label="Drawing tools" />
      <div className="chart-area">
        <div className="chart-host" ref={hostRef} data-testid="chart-host" />
        {initError && <div className="center-message chart-init-error" role="alert">Chart failed to start: {initError}</div>}
        <div className="chart-overlay-top-left">
          <StaleBadge stale={meta.stale} />
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
  );
}

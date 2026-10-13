/**
 * Polling must stop for every symbol / timeframe the chart leaves, including the very first load under
 * React StrictMode (dev double-mount), and when ChartView unmounts (Baskets view).
 * Real ChartView + ChartAdapter + dataLoader; klinecharts replaced by a stub that follows KLineChart 10's
 * store semantics for setSymbol / setPeriod / setDataLoader / resetData (unsubscribe the current loader,
 * then 'init' it; the init callback subscribes whatever loader is current when it runs).
 */
import type { BarsResponse, Layout, LatestResponse, SymbolInfo } from '@chartmate/shared';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api/client';

const k = vi.hoisted(() => {
  type Loader = {
    getBars: (p: unknown) => unknown;
    subscribeBar?: (p: unknown) => void;
    unsubscribeBar?: (p: unknown) => void;
  };
  let seq = 0;
  function makeStore() {
    let loader: Loader | null = null;
    let symbol: unknown = null;
    let period: unknown = null;
    let loading = false;
    let destroyed = false;
    const processInit = () => {
      if (loading || !loader || !symbol || !period) return;
      loading = true;
      void loader.getBars({
        type: 'init', symbol, period, timestamp: null,
        callback: () => {
          loading = false;
          if (destroyed) return;
          loader?.subscribeBar?.({ symbol, period, callback: () => {} });
        },
      });
    };
    const resetData = (fn?: () => void) => {
      if (loader && symbol && period) loader.unsubscribeBar?.({ symbol, period });
      fn?.();
      loading = false;
      processInit();
    };
    return {
      setSymbol: (s: unknown) => resetData(() => { symbol = { ...(symbol as object), ...(s as object) }; }),
      setPeriod: (p: unknown) => resetData(() => { period = p; }),
      setDataLoader: (l: Loader) => resetData(() => { loader = l; }),
      resetData: () => resetData(),
      destroy: () => { destroyed = true; },
    };
  }
  function makeChart() {
    const store = makeStore();
    return {
      store,
      setSymbol: store.setSymbol, setPeriod: store.setPeriod, setDataLoader: store.setDataLoader, resetData: store.resetData,
      setStyles() {}, setTimezone() {}, resize() {},
      getDataList: () => [], getIndicators: () => [], getOverlays: () => [],
      getStyles: () => ({ indicator: { lines: [] } }),
      createIndicator: () => `ind_${++seq}`, overrideIndicator: () => true, removeIndicator: () => true,
      createOverlay: () => `ov_${++seq}`, overrideOverlay: () => true, removeOverlay: () => true,
    };
  }
  const charts = new Map<HTMLElement, ReturnType<typeof makeChart>>();
  return {
    init: (el: HTMLElement) => {
      const existing = charts.get(el);
      if (existing) return existing;
      const c = makeChart();
      charts.set(el, c);
      return c;
    },
    dispose: (el: HTMLElement) => { charts.get(el)?.store.destroy(); charts.delete(el); },
  };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: k.dispose,
  registerIndicator: () => {},
  registerOverlay: () => {},
  getOverlayClass: () => null,
  getSupportedIndicators: () => [],
  getSupportedOverlays: () => [],
}));

const { ChartView } = await import('../../src/components/ChartView');

const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const ETH: SymbolInfo = { id: 'crypto:ETH', assetClass: 'crypto', ticker: 'ETH', name: 'Ethereum', pricePrecision: 2 };
const LAYOUT: Layout = { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };

const NOW = Date.UTC(2026, 9, 12, 12);
let latestCalls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  latestCalls = [];
  vi.spyOn(api.drawings, 'get').mockResolvedValue([]);
  vi.spyOn(api.drawings, 'put').mockResolvedValue(undefined);
  vi.spyOn(api, 'bars').mockImplementation(async (p) => ({
    bars: [{ ts: p.to - 86_400_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }],
    hasMoreBefore: false, stale: false, notices: [], markers: [],
  }) as unknown as BarsResponse);
  vi.spyOn(api, 'latest').mockImplementation(async (p) => {
    latestCalls.push(`${p.symbol}|${p.tf}`);
    return { bar: null, stale: false } as unknown as LatestResponse;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function view(layout: Layout, info: SymbolInfo) {
  return <StrictMode><ChartView layout={layout} setLayout={() => {}} symbolInfo={info} theme="dark" /></StrictMode>;
}

describe('polling lifecycle (StrictMode)', () => {
  it('stops polling the initial symbol/timeframe after switching away and after unmount', async () => {
    const r = render(view(LAYOUT, BTC));
    await settle();
    await advance(11_000);
    expect(latestCalls.filter((c) => c === 'crypto:BTC|1D').length).toBeGreaterThan(0);

    r.rerender(view({ ...LAYOUT, tf: '30m' }, BTC));
    await settle();
    r.rerender(view({ ...LAYOUT, tf: '15m' }, BTC));
    await settle();
    r.rerender(view({ ...LAYOUT, symbol: 'crypto:ETH' }, ETH));
    await settle();
    latestCalls = [];
    await advance(30_000);
    expect(latestCalls.filter((c) => c !== 'crypto:ETH|1D')).toEqual([]);
    expect(latestCalls.length).toBeGreaterThan(0);

    r.unmount();
    latestCalls = [];
    await advance(60_000);
    expect(latestCalls).toEqual([]);
  });
});

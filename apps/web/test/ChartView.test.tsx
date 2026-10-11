import type { Layout, SymbolInfo } from '@altv/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { LoaderEvents } from '../src/chart/dataLoader';

const fake = vi.hoisted(() => {
  const instances: FakeAdapter[] = [];
  class FakeAdapter {
    seq = 0;
    events: LoaderEvents | null = null;
    changeCb: (() => void) | null = null;
    load = vi.fn((_p: unknown, ev: LoaderEvents) => { this.events = ev; });
    setTheme = vi.fn();
    setChartType = vi.fn();
    setSessionShading = vi.fn();
    setMarkers = vi.fn();
    addIndicator = vi.fn(() => `ind_${++this.seq}`);
    updateIndicator = vi.fn();
    removeIndicator = vi.fn();
    restoreDrawings = vi.fn();
    serializeDrawings = vi.fn(() => [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
    onDrawingsChange = vi.fn((cb: () => void) => { this.changeCb = cb; return () => { this.changeCb = null; }; });
    onLockAllChange = vi.fn(() => () => {});
    resize = vi.fn();
    destroy = vi.fn();
    constructor() { instances.push(this); }
  }
  return { instances, FakeAdapter };
});

vi.mock('../src/chart/ChartAdapter', () => ({ ChartAdapter: fake.FakeAdapter }));

const { ChartView } = await import('../src/components/ChartView');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const LAYOUT: Layout = {
  symbol: 'stock:AAPL', tf: '5m', session: 'eth', chartType: 'candle',
  indicators: [{ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true }],
};

const adapter = () => fake.instances.at(-1)!;
const flush = () => act(async () => { await Promise.resolve(); });

function renderView(layout: Layout = LAYOUT, info: SymbolInfo | null = AAPL) {
  const setLayout = vi.fn();
  const r = render(<ChartView layout={layout} setLayout={setLayout} symbolInfo={info} theme="dark" />);
  return { ...r, rerenderWith: (l: Layout, i: SymbolInfo | null = info) => r.rerender(<ChartView layout={l} setLayout={setLayout} symbolInfo={i} theme="dark" />) };
}

beforeEach(() => {
  fake.instances.length = 0;
  vi.spyOn(api.drawings, 'get').mockResolvedValue([]);
  vi.spyOn(api.drawings, 'put').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChartView', () => {
  it('keeps the two-column structure', () => {
    renderView();
    const root = screen.getByTestId('chart-view');
    expect(root.querySelector('.left-toolbar')).not.toBeNull();
    expect(root.querySelector('.chart-area')).not.toBeNull();
  });

  it('loads symbol/tf/session with the asset-class poll interval and applies chart type, shading and VOL', async () => {
    renderView();
    await flush();
    const a = adapter();
    expect(a.load).toHaveBeenCalledTimes(1);
    expect(a.load.mock.calls[0]![0]).toEqual({ symbol: AAPL, tf: '5m', session: 'eth', pollMs: 15000 });
    expect(a.setChartType).toHaveBeenCalledWith('candle');
    expect(a.setSessionShading).toHaveBeenLastCalledWith(true);
    expect(a.addIndicator).toHaveBeenCalledWith({ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true });
  });

  it('waits for symbol info before loading', async () => {
    const { rerenderWith } = renderView(LAYOUT, null);
    await flush();
    expect(adapter().load).not.toHaveBeenCalled();
    rerenderWith(LAYOUT, AAPL);
    await flush();
    expect(adapter().load).toHaveBeenCalledTimes(1);
  });

  it('reloads on tf change, uses 5 s polling for crypto and disables shading for RTH / daily', async () => {
    const { rerenderWith } = renderView();
    await flush();
    rerenderWith({ ...LAYOUT, tf: '1D' });
    await flush();
    expect(adapter().load).toHaveBeenCalledTimes(2);
    expect(adapter().setSessionShading).toHaveBeenLastCalledWith(false);
    rerenderWith({ ...LAYOUT, symbol: 'crypto:BTC', session: 'rth' }, BTC);
    await flush();
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ symbol: BTC, pollMs: 5000, session: 'rth' });
  });

  it('diffs indicators: update on param change, remove when dropped', async () => {
    const { rerenderWith } = renderView();
    await flush();
    rerenderWith({ ...LAYOUT, indicators: [{ name: 'VOL', pane: 'sub', calcParams: [7], visible: false }] });
    expect(adapter().updateIndicator).toHaveBeenCalledWith('ind_1', { calcParams: [7], visible: false });
    rerenderWith({ ...LAYOUT, indicators: [] });
    expect(adapter().removeIndicator).toHaveBeenCalledWith('ind_1');
    expect(adapter().addIndicator).toHaveBeenCalledTimes(1);
  });

  it('shows the stale badge, dismissible notices and error toasts; passes markers to the adapter', async () => {
    renderView();
    await flush();
    const markers = [{ ts: 1, label: 'v2' }];
    act(() => adapter().events!.onMeta({ stale: true, notices: ['Series starts 2020-06-01 (limited by stock:XYZ)'], markers }));
    expect(screen.getByText(/Data delayed/)).toBeInTheDocument();
    expect(screen.getByText(/limited by stock:XYZ/)).toBeInTheDocument();
    expect(adapter().setMarkers).toHaveBeenLastCalledWith(markers);
    act(() => screen.getByRole('button', { name: 'Dismiss notice' }).click());
    expect(screen.queryByText(/limited by stock:XYZ/)).not.toBeInTheDocument();
    act(() => adapter().events!.onError(new Error('Provider unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable');
  });

  it('restores drawings on symbol load and saves them debounced 1 s after a change', async () => {
    vi.mocked(api.drawings.get).mockResolvedValue([{ name: 'rayLine', points: [{ timestamp: 5, value: 5 }], lock: false }]);
    renderView();
    await flush();
    await flush();
    expect(api.drawings.get).toHaveBeenCalledWith('stock:AAPL');
    expect(adapter().restoreDrawings).toHaveBeenLastCalledWith([{ name: 'rayLine', points: [{ timestamp: 5, value: 5 }], lock: false }], 'stock:AAPL');
    vi.useFakeTimers();
    act(() => adapter().changeCb!());
    act(() => { vi.advanceTimersByTime(999); });
    expect(api.drawings.put).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(api.drawings.put).toHaveBeenCalledWith('stock:AAPL', [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
  });

  it('destroys the adapter on unmount', async () => {
    const { unmount } = renderView();
    await flush();
    const a = adapter();
    unmount();
    expect(a.destroy).toHaveBeenCalled();
  });
});

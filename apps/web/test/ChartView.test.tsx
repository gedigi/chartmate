import type { Basket, Layout, SymbolInfo } from '@chartmate/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { notifyBasketChanged } from '../src/state/useBaskets';
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
    clear = vi.fn();
    startDrawing = vi.fn();
    cancelDrawing = vi.fn();
    clearDrawings = vi.fn();
    removeSelected = vi.fn(() => false);
    setMagnet = vi.fn();
    setLockAll = vi.fn();
    setAppearance = vi.fn();
    setMagnetOverride = vi.fn();
    setSelectedStyle = vi.fn();
    deselect = vi.fn();
    clearMeasure = vi.fn();
    measureCb: ((m: { lines: string[] } | null) => void) | null = null;
    onMeasureChange = vi.fn((cb: (m: { lines: string[] } | null) => void) => { this.measureCb = cb; return () => { this.measureCb = null; }; });
    /** Every subscriber (the style bar and the drawing toolbar both listen), like the real adapter. */
    selectionCbs = new Set<(s: unknown) => void>();
    selectionCb: ((s: unknown) => void) | null = (s) => { for (const cb of this.selectionCbs) cb(s); };
    onSelectionChange = vi.fn((cb: (s: unknown) => void) => { this.selectionCbs.add(cb); return () => { this.selectionCbs.delete(cb); }; });
    setSelectedPrice = vi.fn(() => true);
    setSelectedLabel = vi.fn();
    setShiftConstraint = vi.fn();
    onPriceEditRequest = vi.fn(() => () => {});
    setPositionDefaults = vi.fn();
    setNewDrawingColor = vi.fn();
    drawingSwatches = vi.fn(() => [
      { token: 'accent', color: '#7cc4ff', name: 'Sky' }, { token: 'text', color: '#e9ecf4', name: 'White' },
      { token: 'muted', color: '#8f97ab', name: 'Gray' }, { token: 'up', color: '#3ccfd0', name: 'Up color' },
      { token: 'down', color: '#e76a88', name: 'Down color' }, { token: 'palette:0', color: '#f2b861', name: 'Gold' },
    ]);
    resetSelectedColor = vi.fn();
    setSelectedPositionPrices = vi.fn(() => null);
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

function renderView(layout: Layout = LAYOUT, info: SymbolInfo | null = AAPL, extra: { symbolError?: string | null; onRetrySymbol?: () => void } = {}) {
  const setLayout = vi.fn();
  const r = render(<ChartView layout={layout} setLayout={setLayout} symbolInfo={info} theme="dark" {...extra} />);
  return {
    ...r,
    rerenderWith: (l: Layout, i: SymbolInfo | null = info, e: typeof extra = extra) =>
      r.rerender(<ChartView layout={l} setLayout={setLayout} symbolInfo={i} theme="dark" {...e} />),
  };
}

function fireInput(el: HTMLInputElement, value: string) {
  fireEvent.input(el, { target: { value } });
}
function fireChange(el: HTMLSelectElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

const trendLine = () => screen.getByRole('button', { name: 'Trend line' });
const meta = (stale = false) => ({ stale, notices: [], markers: [] });

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
  it('announces a finished Shift measure to screen readers (and nothing once it is cleared)', () => {
    renderView();
    const readout = screen.getByTestId('measure-readout');
    expect(readout).toHaveAttribute('role', 'status');
    expect(readout).toHaveTextContent('');
    act(() => adapter().measureCb?.({ lines: ['+1.50 (+0.46%)', '12 bars, 3d 4h'] }));
    expect(readout).toHaveTextContent('Measure: +1.50 (+0.46%), 12 bars, 3d 4h');
    act(() => adapter().measureCb?.(null));
    expect(readout).toHaveTextContent('');
  });

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
    expect(adapter().updateIndicator).toHaveBeenCalledWith('ind_1', { calcParams: [7, 10, 20], visible: false });
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

  it('flushes the pending drawings save for the previous symbol immediately on a symbol switch', async () => {
    const { rerenderWith } = renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    act(() => adapter().changeCb!());
    act(() => { vi.advanceTimersByTime(300); });
    expect(api.drawings.put).not.toHaveBeenCalled();
    rerenderWith({ ...LAYOUT, symbol: 'crypto:BTC' }, BTC);
    expect(api.drawings.put).toHaveBeenCalledTimes(1);
    expect(api.drawings.put).toHaveBeenCalledWith('stock:AAPL', [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
    // B's load + an immediate edit on B must not resurrect or overwrite A's save.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => adapter().changeCb!());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(vi.mocked(api.drawings.put).mock.calls.map((c) => c[0])).toEqual(['stock:AAPL', 'crypto:BTC']);
  });

  it('symbol info failure: stops/blanks the previous chart, shows an opaque error panel whose Retry retries', async () => {
    const onRetrySymbol = vi.fn();
    const { rerenderWith } = renderView(LAYOUT, AAPL, { onRetrySymbol });
    await flush();
    expect(adapter().load).toHaveBeenCalledTimes(1);
    // Switch to MSFT whose info is still loading: the AAPL loader must stop at once (no polling under MSFT).
    rerenderWith({ ...LAYOUT, symbol: 'stock:MSFT' }, null, { onRetrySymbol });
    await flush();
    expect(adapter().clear).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
    rerenderWith({ ...LAYOUT, symbol: 'stock:MSFT' }, null, { symbolError: 'Network error', onRetrySymbol });
    const panel = screen.getByTestId('symbol-error');
    expect(panel).toHaveClass('chart-error-panel');
    expect(panel).toHaveTextContent("Couldn't load symbol stock:MSFT: Network error");
    expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Retry' }).click());
    expect(onRetrySymbol).toHaveBeenCalledTimes(1);
    expect(adapter().load).toHaveBeenCalledTimes(1);
    expect(trendLine()).toBeDisabled();
  });

  it('shows a loading overlay until the first data of each load arrives', async () => {
    const { rerenderWith } = renderView();
    await flush();
    expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
    act(() => adapter().events!.onMeta(meta()));
    expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    rerenderWith({ ...LAYOUT, tf: '1h' });
    await flush();
    expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
  });

  it('an outage shows one persistent banner + stale badge (no toasts) and clears on recovery', async () => {
    renderView();
    await flush();
    act(() => adapter().events!.onMeta(meta()));
    act(() => adapter().events!.onConnection!(true, new Error('Network error')));
    expect(screen.getAllByText('Connection lost — retrying…')).toHaveLength(1);
    expect(screen.getByText(/Data delayed/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => adapter().events!.onConnection!(false));
    expect(screen.queryByText('Connection lost — retrying…')).not.toBeInTheDocument();
    expect(screen.queryByText(/Data delayed/)).not.toBeInTheDocument();
  });

  it('migrates stored indicator params when they reach the chart (short lists padded with defaults)', async () => {
    const short = { name: 'RSI', pane: 'sub' as const, calcParams: [7], visible: true };
    const { rerenderWith } = renderView({ ...LAYOUT, indicators: [short] });
    await flush();
    expect(adapter().addIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: 'RSI', calcParams: [7, 12, 24] }));
    rerenderWith({ ...LAYOUT, indicators: [{ ...short, calcParams: [8], visible: false }] });
    expect(adapter().updateIndicator).toHaveBeenLastCalledWith('ind_1', expect.objectContaining({ calcParams: [8, 12, 24], visible: false }));
  });

  it('a permanent load error shows its message inline in an opaque panel with Retry (no "Connection lost")', async () => {
    renderView();
    await flush();
    expect(adapter().load).toHaveBeenCalledTimes(1);
    act(() => adapter().events!.onFatal!(new Error('Basket has no constituents')));
    const panel = screen.getByTestId('load-error');
    expect(panel).toHaveClass('chart-error-panel');
    expect(panel).toHaveAttribute('role', 'alert');
    expect(panel).toHaveTextContent("Couldn't load AAPL: Basket has no constituents");
    expect(screen.queryByText('Connection lost — retrying…')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(adapter().load).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('load-error')).not.toBeInTheDocument();
  });

  it('places notices in the bottom-left stack, away from the top-left OHLC legend', async () => {
    renderView();
    await flush();
    act(() => adapter().events!.onMeta({ stale: false, notices: ['Some notice'], markers: [] }));
    expect(screen.getByText('Some notice').closest('.chart-overlay-bottom-left')).not.toBeNull();
  });

  it('drawing tools stay disabled until the symbol\'s drawings and first data are in', async () => {
    renderView();
    await flush();
    await flush();
    expect(trendLine()).toBeDisabled(); // drawings loaded, data not yet
    act(() => adapter().events!.onMeta(meta()));
    expect(trendLine()).toBeEnabled();
  });

  it('retries a failed drawings load with backoff and keeps saving disabled until it succeeds', async () => {
    vi.useFakeTimers();
    vi.mocked(api.drawings.get)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce([]);
    renderView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => adapter().events!.onMeta(meta()));
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load drawings/);
    expect(trendLine()).toBeDisabled();
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(api.drawings.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.drawings.get).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.drawings.get).toHaveBeenCalledTimes(3);
    expect(api.drawings.put).not.toHaveBeenCalled();
    expect(trendLine()).toBeEnabled();
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.drawings.put).toHaveBeenCalledTimes(1);
  });

  it('re-derives the basket poll interval when the basket is edited', async () => {
    const B: SymbolInfo = { id: 'basket:b1', assetClass: 'basket', ticker: 'B1', name: 'B1', pricePrecision: 2 };
    const stocks: Basket = { id: 'b1', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0,
      versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } }] };
    const get = vi.spyOn(api.baskets, 'get').mockResolvedValue(stocks);
    renderView({ ...LAYOUT, symbol: 'basket:b1' }, B);
    await flush();
    await flush();
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ pollMs: 15000, basketHasCrypto: false });
    get.mockResolvedValue({ ...stocks, versions: [...stocks.versions, { effectiveFrom: '2024-02-01', weights: { 'crypto:BTC': 1 } }] });
    act(() => notifyBasketChanged('b1'));
    await flush();
    await flush();
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ pollMs: 5000, basketHasCrypto: true });
  });

  it('applies the appearance and re-applies it only when it changes by value', async () => {
    const appearance = { dark: { upColor: '#00ff00' } };
    const { rerenderWith } = renderView({ ...LAYOUT, appearance });
    await flush();
    expect(adapter().setAppearance).toHaveBeenLastCalledWith(appearance);
    const n = adapter().setAppearance.mock.calls.length;
    rerenderWith({ ...LAYOUT, appearance: { ...appearance } });
    expect(adapter().setAppearance).toHaveBeenCalledTimes(n);
    rerenderWith({ ...LAYOUT, appearance: { dark: { upColor: '#0000ff' } } });
    expect(adapter().setAppearance).toHaveBeenLastCalledWith({ dark: { upColor: '#0000ff' } });
    rerenderWith(LAYOUT);
    expect(adapter().setAppearance).toHaveBeenLastCalledWith(undefined);
  });

  it('applies the layout position defaults to the adapter, re-applied only when they change by value', async () => {
    const positionDefaults = { targetPct: 3, stopPct: 1.5 };
    const { rerenderWith } = renderView({ ...LAYOUT, positionDefaults });
    await flush();
    expect(adapter().setPositionDefaults).toHaveBeenLastCalledWith(positionDefaults);
    const n = adapter().setPositionDefaults.mock.calls.length;
    rerenderWith({ ...LAYOUT, positionDefaults: { ...positionDefaults } });
    expect(adapter().setPositionDefaults).toHaveBeenCalledTimes(n);
    rerenderWith(LAYOUT);
    expect(adapter().setPositionDefaults).toHaveBeenLastCalledWith(undefined);
  });

  it('"Use as default" in the position bar writes positionDefaults into the layout', async () => {
    const setLayout = vi.fn();
    render(<ChartView layout={LAYOUT} setLayout={setLayout} symbolInfo={AAPL} theme="dark" />);
    await flush();
    act(() => adapter().selectionCb?.({
      id: 'p', kind: 'position', side: 'long', locked: false, entry: 100, target: 103, stop: 99, precision: 2,
      metrics: { rr: 3, targetPct: 3, stopPct: 1 }, outcome: { kind: 'waiting' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Use as default' }));
    const update = setLayout.mock.calls.at(-1)![0] as (l: Layout) => Layout;
    expect(update(LAYOUT)).toEqual({ ...LAYOUT, positionDefaults: { targetPct: 3, stopPct: 1 } });
  });

  it('a picked swatch becomes the layout drawingColor (new drawings use it); "Reset to default" removes it', async () => {
    const setLayout = vi.fn();
    const { rerender } = render(<ChartView layout={LAYOUT} setLayout={setLayout} symbolInfo={AAPL} theme="dark" />);
    await flush();
    expect(adapter().setNewDrawingColor).toHaveBeenLastCalledWith(undefined);
    act(() => adapter().selectionCb?.({ id: 'a', kind: 'line', style: { color: 'accent', size: 1, style: 'solid' }, locked: false, ownLock: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Drawing color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Gold' }));
    const pick = setLayout.mock.calls.at(-1)![0] as (l: Layout) => Layout;
    expect(pick(LAYOUT)).toEqual({ ...LAYOUT, drawingColor: 'palette:0' });
    rerender(<ChartView layout={{ ...LAYOUT, drawingColor: 'palette:0' }} setLayout={setLayout} symbolInfo={AAPL} theme="dark" />);
    expect(adapter().setNewDrawingColor).toHaveBeenLastCalledWith('palette:0');
    fireEvent.click(screen.getByRole('button', { name: 'Drawing color' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(adapter().resetSelectedColor).toHaveBeenCalledTimes(1);
    const reset = setLayout.mock.calls.at(-1)![0] as (l: Layout) => Layout;
    expect(reset({ ...LAYOUT, drawingColor: 'palette:0' })).toEqual(LAYOUT);
  });

  it('re-picking the swatch the drawing already has still sets the layout drawingColor', async () => {
    const setLayout = vi.fn();
    render(<ChartView layout={LAYOUT} setLayout={setLayout} symbolInfo={AAPL} theme="dark" />);
    await flush();
    act(() => adapter().selectionCb?.({ id: 'a', kind: 'line', style: { color: 'palette:0', size: 1, style: 'solid' }, locked: false, ownLock: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Drawing color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Gold' }));
    expect(adapter().setSelectedStyle).not.toHaveBeenCalled();
    const pick = setLayout.mock.calls.at(-1)![0] as (l: Layout) => Layout;
    expect(pick(LAYOUT)).toEqual({ ...LAYOUT, drawingColor: 'palette:0' });
  });

  it('passes indicator line widths / styles / bar colors to the adapter', async () => {
    const vol = { name: 'VOL', pane: 'sub' as const, calcParams: [5, 10, 20], visible: true, lineWidths: [2], lineStyles: ['dashed' as const], barColors: { up: '#00ff00', down: '#ff0000' } };
    const { rerenderWith } = renderView({ ...LAYOUT, indicators: [vol] });
    await flush();
    expect(adapter().addIndicator).toHaveBeenCalledWith(expect.objectContaining({ lineWidths: [2], lineStyles: ['dashed'], barColors: { up: '#00ff00', down: '#ff0000' } }));
    rerenderWith({ ...LAYOUT, indicators: [{ ...vol, lineWidths: [4] }] });
    expect(adapter().updateIndicator).toHaveBeenLastCalledWith('ind_1', expect.objectContaining({ lineWidths: [4], lineStyles: ['dashed'] }));
  });

  it('passes indicator reference levels to the adapter; removing them falls back to the defaults', async () => {
    const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [14], visible: true, levels: [80, 50, 20] };
    const { rerenderWith } = renderView({ ...LAYOUT, indicators: [rsi] });
    await flush();
    expect(adapter().addIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: 'RSI', levels: [80, 50, 20] }));
    rerenderWith({ ...LAYOUT, indicators: [{ ...rsi, showLevels: false }] });
    expect(adapter().updateIndicator).toHaveBeenLastCalledWith('ind_1', expect.objectContaining({ levels: [80, 50, 20], showLevels: false }));
    rerenderWith({ ...LAYOUT, indicators: [{ name: 'RSI', pane: 'sub', calcParams: [14], visible: true }] });
    const last = adapter().updateIndicator.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last).not.toHaveProperty('levels');
    expect(last).not.toHaveProperty('showLevels');
  });

  it('shows notices even when the response has no bars (basket empty state)', async () => {
    renderView();
    await flush();
    act(() => adapter().events!.onMeta({ stale: false, notices: ['Basket starts 2026-10-12; no completed sessions yet.'], markers: [] }));
    expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
    expect(screen.getByText('Basket starts 2026-10-12; no completed sessions yet.')).toBeVisible();
  });

  it('shows a style bar for the selected drawing and applies changes through the adapter', async () => {
    renderView();
    await flush();
    expect(screen.queryByRole('toolbar', { name: 'Drawing style' })).not.toBeInTheDocument();
    act(() => adapter().selectionCb!({ id: 'ov_1', kind: 'line', style: { color: '#ff0000', size: 2, style: 'solid' } }));
    const bar = screen.getByRole('toolbar', { name: 'Drawing style' });
    expect(bar).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Drawing color' }));
    expect(screen.getByRole('option', { name: 'Custom #ff0000' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'Gold' }));
    expect(adapter().setSelectedStyle).toHaveBeenLastCalledWith({ color: 'palette:0' });
    act(() => { fireChange(screen.getByLabelText('Line width') as HTMLSelectElement, '4'); });
    expect(adapter().setSelectedStyle).toHaveBeenLastCalledWith({ size: 4 });
    act(() => { fireChange(screen.getByLabelText('Line style') as HTMLSelectElement, 'dashed'); });
    expect(adapter().setSelectedStyle).toHaveBeenLastCalledWith({ style: 'dashed' });
    act(() => adapter().selectionCb!({ id: 'ov_2', kind: 'text', style: { color: '#ff0000', size: 12 } }));
    expect(screen.queryByLabelText('Line style')).not.toBeInTheDocument();
    act(() => { fireChange(screen.getByLabelText('Font size') as HTMLSelectElement, '18'); });
    expect(adapter().setSelectedStyle).toHaveBeenLastCalledWith({ size: 18 });
    act(() => adapter().selectionCb!(null));
    expect(screen.queryByRole('toolbar', { name: 'Drawing style' })).not.toBeInTheDocument();
  });

  it('destroys the adapter on unmount', async () => {
    const { unmount } = renderView();
    await flush();
    const a = adapter();
    unmount();
    expect(a.destroy).toHaveBeenCalled();
  });
});

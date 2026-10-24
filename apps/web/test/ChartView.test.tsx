import type { Basket, Layout, SymbolInfo } from '@chartmate/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { resetCorporateEvents } from '../src/state/corporateEvents';
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
    setEvents = vi.fn();
    eventHoverCb: ((h: unknown) => void) | null = null;
    onEventHover = vi.fn((cb: (h: unknown) => void) => { this.eventHoverCb = cb; return () => { this.eventHoverCb = null; }; });
    eventsShownCb: ((g: unknown) => void) | null = null;
    onEventsShown = vi.fn((cb: (g: unknown) => void) => { this.eventsShownCb = cb; return () => { this.eventsShownCb = null; }; });
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
    setNewDrawingDefaults = vi.fn();
    drawingSwatches = vi.fn(() => [
      { token: 'accent', color: '#7cc4ff', name: 'Sky' }, { token: 'text', color: '#e9ecf4', name: 'White' },
      { token: 'muted', color: '#8f97ab', name: 'Gray' }, { token: 'up', color: '#3ccfd0', name: 'Up color' },
      { token: 'down', color: '#e76a88', name: 'Down color' }, { token: 'palette:0', color: '#f2b861', name: 'Gold' },
    ]);
    resetSelectedColor = vi.fn();
    setSelectedPositionPrices = vi.fn(() => null);
    showRange = vi.fn();
    rangeCanceledCb: (() => void) | null = null;
    onRangeCanceled = vi.fn((cb: () => void) => { this.rangeCanceledCb = cb; return () => { this.rangeCanceledCb = null; }; });
    plotWidth = vi.fn(() => 1000);
    rangeShownCb: ((s: unknown) => void) | null = null;
    onRangeShown = vi.fn((cb: (s: unknown) => void) => { this.rangeShownCb = cb; return () => { this.rangeShownCb = null; }; });
    constructor() { instances.push(this); }
  }
  return { instances, FakeAdapter };
});

vi.mock('../src/chart/ChartAdapter', () => ({ ChartAdapter: fake.FakeAdapter }));

const { ChartView, mergeDrawingDefaults } = await import('../src/components/ChartView');
const { DrawingsSavers } = await import('../src/components/DrawingsSave');
const { drawingsStore } = await import('../src/state/drawingsStore');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const LAYOUT: Layout = {
  symbol: 'stock:AAPL', tf: '5m', session: 'eth', chartType: 'candle',
  indicators: [{ name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true }],
};

const adapter = () => fake.instances.at(-1)!;
const flush = () => act(async () => { await Promise.resolve(); });

function renderView(layout: Layout = LAYOUT, info: SymbolInfo | null = AAPL, extra: { symbolError?: string | null; symbolDeleted?: boolean; onRetrySymbol?: () => void } = {}) {
  const setLayout = vi.fn();
  // The drawings savers live in the app shell (above the chart view): mounted next to the view, like App does.
  const r = render(<><ChartView layout={layout} setLayout={setLayout} symbolInfo={info} theme="dark" {...extra} /><DrawingsSavers /></>);
  return {
    ...r,
    rerenderWith: (l: Layout, i: SymbolInfo | null = info, e: typeof extra = extra) =>
      r.rerender(<><ChartView layout={l} setLayout={setLayout} symbolInfo={i} theme="dark" {...e} /><DrawingsSavers /></>),
    /** Leaves the chart view (e.g. the Baskets page): the view unmounts, the savers stay. */
    leaveChart: () => r.rerender(<>{null}<DrawingsSavers /></>),
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
  drawingsStore.reset();
  vi.spyOn(api.drawings, 'get').mockResolvedValue([]);
  vi.spyOn(api.drawings, 'put').mockResolvedValue(undefined);
  vi.spyOn(api, 'events').mockImplementation(async (symbol) => ({ symbol, events: [] }));
  resetCorporateEvents();
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

  it('removing an indicator keeps every later one (no re-creation: pane heights survive)', async () => {
    const vol = { name: 'VOL', pane: 'sub' as const, calcParams: [5, 10, 20], visible: true };
    const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [6, 12, 24], visible: true };
    const macd = { name: 'MACD', pane: 'sub' as const, calcParams: [12, 26, 9], visible: true };
    const { rerenderWith } = renderView({ ...LAYOUT, indicators: [vol, rsi, macd] });
    await flush();
    expect(adapter().addIndicator).toHaveBeenCalledTimes(3); // ind_1 VOL, ind_2 RSI, ind_3 MACD
    rerenderWith({ ...LAYOUT, indicators: [rsi, macd] });
    expect(adapter().removeIndicator.mock.calls).toEqual([['ind_1']]);
    expect(adapter().addIndicator).toHaveBeenCalledTimes(3);
    expect(adapter().updateIndicator).not.toHaveBeenCalled();
    // Two of a kind: removing the first RSI keeps the second one's chart indicator (it becomes the first RSI).
    const rsi2 = { ...rsi, calcParams: [14, 12, 24] };
    rerenderWith({ ...LAYOUT, indicators: [rsi, macd, rsi2] }); // ind_4
    rerenderWith({ ...LAYOUT, indicators: [macd, rsi2] });
    expect(adapter().removeIndicator.mock.calls.at(-1)).toEqual(['ind_4']);
    expect(adapter().updateIndicator).toHaveBeenLastCalledWith('ind_2', expect.objectContaining({ calcParams: [14, 12, 24] }));
    expect(adapter().addIndicator).toHaveBeenCalledTimes(4);
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

  it('retries a failed drawings save with backoff until it succeeds', async () => {
    renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockRejectedValueOnce(new Error('offline'));
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.drawings.put).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.drawings.put).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.drawings.put).mock.calls[1]![0]).toBe('stock:AAPL');
  });

  it('drawings saves that keep failing stop after the retry limit: one "Drawings not saved for AAPL." note with Retry', async () => {
    renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockRejectedValue(new Error('offline'));
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Drawings not saved for AAPL. Retrying…').closest('.save-note')).toHaveClass('is-warn');
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    const note = screen.getByText('Drawings not saved for AAPL.').closest('.save-note')!;
    expect(note).toHaveClass('is-warn');
    expect(note).toHaveAttribute('title', 'AAPL: offline');
    // Placed in the chart's top row (beside the indicator chips, outside the plot), never over the canvas.
    expect(note.closest('.chart-save-notes')).not.toBeNull();
    expect(note.closest('.chart-stage')).toBeNull();
    vi.mocked(api.drawings.put).mockResolvedValue(undefined);
    await act(async () => { screen.getByRole('button', { name: 'Retry saving the drawings' }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(/Drawings not saved/)).not.toBeInTheDocument();
  });

  it('a stalled drawings save belongs to its symbol: kept across a switch, not dropped by edits on the new symbol, restored on return', async () => {
    const { rerenderWith } = renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    const aaplDrawings = [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }];
    vi.mocked(api.drawings.put).mockRejectedValue(new Error('offline'));
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(screen.getByText('Drawings not saved for AAPL.')).toBeInTheDocument();
    // Switch to BTC and edit there: BTC is saved; AAPL's unsaved drawings stay pending (and named).
    vi.mocked(api.drawings.put).mockImplementation(async (sym) => { if (sym === 'stock:AAPL') throw new Error('offline'); });
    rerenderWith({ ...LAYOUT, symbol: 'crypto:BTC' }, BTC);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.drawings.put).toHaveBeenLastCalledWith('crypto:BTC', aaplDrawings);
    expect(screen.getByText('Drawings not saved for AAPL.')).toBeInTheDocument();
    // Back on AAPL: its unsaved drawings are restored from memory (not the server's older copy).
    vi.mocked(api.drawings.get).mockClear();
    rerenderWith(LAYOUT, AAPL);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.drawings.get).not.toHaveBeenCalled();
    expect(adapter().restoreDrawings).toHaveBeenLastCalledWith(aaplDrawings, 'stock:AAPL');
    vi.mocked(api.drawings.put).mockResolvedValue(undefined);
    await act(async () => { screen.getByRole('button', { name: 'Retry saving the drawings' }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(api.drawings.put).toHaveBeenLastCalledWith('stock:AAPL', aaplDrawings);
    expect(screen.queryByText(/Drawings not saved/)).not.toBeInTheDocument();
  });

  it('several symbols with unsaved drawings share ONE note ("…for AAPL, BTC and 1 more."); Retry retries them all', async () => {
    const MSFT: SymbolInfo = { id: 'stock:MSFT', assetClass: 'stock', ticker: 'MSFT', name: 'Microsoft', pricePrecision: 2 };
    const { rerenderWith } = renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockRejectedValue(new Error('offline'));
    for (const [l, i] of [[LAYOUT, AAPL], [{ ...LAYOUT, symbol: 'crypto:BTC' }, BTC], [{ ...LAYOUT, symbol: 'stock:MSFT' }, MSFT]] as const) {
      rerenderWith(l, i);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => adapter().changeCb!());
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(document.querySelectorAll('.chart-save-notes .save-note')).toHaveLength(1);
    expect(screen.getByText('Drawings not saved for AAPL, BTC and 1 more.')).toBeInTheDocument();
    vi.mocked(api.drawings.put).mockClear();
    vi.mocked(api.drawings.put).mockResolvedValue(undefined);
    await act(async () => { screen.getByRole('button', { name: 'Retry saving the drawings' }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(vi.mocked(api.drawings.put).mock.calls.map((c) => c[0]).sort()).toEqual(['crypto:BTC', 'stock:AAPL', 'stock:MSFT']);
    expect(screen.queryByText(/Drawings not saved/)).not.toBeInTheDocument();
  });

  it('a permanent failure after leaving the symbol keeps the drawings (red note) until explicitly discarded', async () => {
    const { ApiError } = await import('../src/api/client');
    const { rerenderWith } = renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockImplementation(async (sym) => { if (sym === 'stock:AAPL') throw new ApiError(400, 'invalid', 'too large'); });
    act(() => adapter().changeCb!());
    rerenderWith({ ...LAYOUT, symbol: 'crypto:BTC' }, BTC); // flushes AAPL at once: it fails for good
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const note = screen.getByRole('alert');
    expect(note).toHaveTextContent('Drawings not saved for AAPL.');
    expect(note).toHaveClass('is-error');
    expect(drawingsStore.getSnapshot().values.has('stock:AAPL')).toBe(true);
    act(() => screen.getByRole('button', { name: 'Discard the drawings that could not be saved' }).click());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(drawingsStore.getSnapshot().values.has('stock:AAPL')).toBe(false);
  });

  it('discarding the charted symbol\'s rejected drawings reloads the server\'s drawings onto the chart', async () => {
    const { ApiError } = await import('../src/api/client');
    renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockRejectedValue(new ApiError(400, 'invalid', 'too large'));
    act(() => adapter().changeCb!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Drawings not saved for AAPL.');
    const server = [{ name: 'rayLine', points: [{ timestamp: 5, value: 5 }], lock: false }];
    vi.mocked(api.drawings.get).mockResolvedValue(server);
    vi.mocked(api.drawings.get).mockClear();
    await act(async () => { screen.getByRole('button', { name: /Discard/ }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(api.drawings.get).toHaveBeenCalledWith('stock:AAPL');
    expect(adapter().restoreDrawings).toHaveBeenLastCalledWith(server, 'stock:AAPL');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaving the chart view keeps retrying unsaved drawings (the savers live above the view)', async () => {
    const { leaveChart } = renderView();
    await flush();
    await flush();
    vi.useFakeTimers();
    vi.mocked(api.drawings.put).mockRejectedValueOnce(new Error('offline'));
    act(() => adapter().changeCb!());
    leaveChart(); // flushed at once (fails), then retried while the chart view is gone
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.drawings.put).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.drawings.put).toHaveBeenCalledTimes(2);
    expect(api.drawings.put).toHaveBeenLastCalledWith('stock:AAPL', [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }]);
    expect(drawingsStore.getSnapshot().values.has('stock:AAPL')).toBe(false); // saved: dropped
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
    // The indicator chips belong to a chart: hidden while the symbol failed (error or deleted basket).
    expect(screen.queryByRole('list', { name: /active indicators/i })).not.toBeInTheDocument();
    rerenderWith({ ...LAYOUT, symbol: 'basket:gone' }, null, { symbolError: 'not found', symbolDeleted: true, onRetrySymbol });
    expect(screen.getByTestId('symbol-deleted')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /active indicators/i })).not.toBeInTheDocument();
    rerenderWith(LAYOUT, AAPL, { onRetrySymbol });
    expect(screen.getByRole('list', { name: /active indicators/i })).toBeInTheDocument();
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

  it('a permanent drawings load failure is reported once and not retried; drawing stays disabled', async () => {
    vi.useFakeTimers();
    const { ApiError } = await import('../src/api/client');
    vi.mocked(api.drawings.get).mockRejectedValue(new ApiError(403, 'forbidden', 'Forbidden'));
    renderView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => adapter().events!.onMeta(meta()));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load drawings: Forbidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.drawings.get).toHaveBeenCalledTimes(1);
    expect(trendLine()).toBeDisabled();
  });

  it('a failed basket lookup still loads the chart (stock grid) and is retried: a crypto basket then polls at 5 s', async () => {
    vi.useFakeTimers();
    const B: SymbolInfo = { id: 'basket:b1b1b1b1-0000-4000-8000-000000000001', assetClass: 'basket', ticker: 'B1', name: 'B1', pricePrecision: 2 };
    const crypto: Basket = { id: 'b1b1b1b1-0000-4000-8000-000000000001', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0,
      versions: [{ effectiveFrom: '2024-01-02', weights: { 'crypto:BTC': 1 } }] };
    const get = vi.spyOn(api.baskets, 'get').mockRejectedValueOnce(new Error('down')).mockResolvedValue(crypto);
    renderView({ ...LAYOUT, symbol: 'basket:b1b1b1b1-0000-4000-8000-000000000001' }, B);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ pollMs: 15000, basketHasCrypto: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ pollMs: 5000, basketHasCrypto: true });
  });

  it('re-derives the basket poll interval when the basket is edited', async () => {
    const B: SymbolInfo = { id: 'basket:b1b1b1b1-0000-4000-8000-000000000001', assetClass: 'basket', ticker: 'B1', name: 'B1', pricePrecision: 2 };
    const stocks: Basket = { id: 'b1b1b1b1-0000-4000-8000-000000000001', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0,
      versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } }] };
    const get = vi.spyOn(api.baskets, 'get').mockResolvedValue(stocks);
    renderView({ ...LAYOUT, symbol: 'basket:b1b1b1b1-0000-4000-8000-000000000001' }, B);
    await flush();
    await flush();
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ pollMs: 15000, basketHasCrypto: false });
    get.mockResolvedValue({ ...stocks, versions: [...stocks.versions, { effectiveFrom: '2024-02-01', weights: { 'crypto:BTC': 1 } }] });
    act(() => notifyBasketChanged('b1b1b1b1-0000-4000-8000-000000000001'));
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
    act(() => adapter().selectionCb?.({ id: 'a', kind: 'line', name: 'segment', style: { color: 'accent', size: 1, style: 'solid' }, locked: false, ownLock: false }));
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
    act(() => adapter().selectionCb?.({ id: 'a', kind: 'line', name: 'segment', style: { color: 'palette:0', size: 1, style: 'solid' }, locked: false, ownLock: false }));
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
    act(() => adapter().selectionCb!({ id: 'ov_1', kind: 'line', name: 'segment', style: { color: '#ff0000', size: 2, style: 'solid' } }));
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

describe('ChartView date ranges', () => {
  /** Renders a ChartView whose setLayout applies updates (re-rendering with the new layout), like the app shell. */
  function renderLive(initial: Layout, info: SymbolInfo = AAPL) {
    let layout = initial;
    const setLayout = vi.fn((fn: (l: Layout) => Layout) => {
      layout = fn(layout);
      r.rerender(<ChartView layout={layout} setLayout={setLayout} symbolInfo={info} theme="dark" />);
    });
    const r = render(<ChartView layout={layout} setLayout={setLayout} symbolInfo={info} theme="dark" />);
    return {
      setLayout, layout: () => layout, unmount: () => r.unmount(),
      rerender: (l: Layout) => { layout = l; r.rerender(<ChartView layout={l} setLayout={setLayout} symbolInfo={info} theme="dark" />); },
    };
  }
  const rangeButton = (name: string) => within(screen.getByRole('group', { name: 'Date range' })).getByRole('button', { name });
  const dataIn = () => act(() => adapter().events!.onMeta(meta()));

  it('sits in a row under the chart, disabled until the symbol\'s first data arrives', async () => {
    renderLive(LAYOUT);
    await flush();
    const group = screen.getByRole('group', { name: 'Date range' });
    expect(group.closest('.chart-bottomrow')).not.toBeNull();
    expect(rangeButton('1Y')).toBeDisabled();
    dataIn();
    expect(rangeButton('1Y')).toBeEnabled();
  });

  it('stays enabled while a picked range loads its interval: the clicked button keeps the focus', async () => {
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    await userEvent.click(rangeButton('1Y'));
    expect(v.layout().tf).toBe('1D');
    expect(adapter().load.mock.calls.at(-1)![0]).toMatchObject({ tf: '1D' }); // reloading: no data of 1D yet
    expect(rangeButton('1Y')).toBeEnabled();
    expect(rangeButton('5D')).toBeEnabled();
    expect(document.activeElement).toBe(rangeButton('1Y'));
  });

  it('a new symbol disables the row until its own data arrives', async () => {
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => v.rerender({ ...v.layout(), symbol: 'stock:MSFT' }));
    expect(rangeButton('1Y')).toBeDisabled();
  });

  it('fades the row\'s edges where it scrolls (narrow charts)', async () => {
    renderLive(LAYOUT);
    await flush();
    const row = screen.getByRole('group', { name: 'Date range' }).closest('.chart-bottomrow') as HTMLElement;
    expect(row.dataset.fade).toBe('none');
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 500 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 300 });
    fireEvent.scroll(row);
    expect(row.dataset.fade).toBe('end');
  });

  it('1Y on a 5m chart switches to 1D, then shows the range on the new data (selected)', async () => {
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => { fireEvent.click(rangeButton('1Y')); });
    expect(v.layout().tf).toBe('1D');
    const a = adapter();
    expect(a.load.mock.calls.at(-1)![0]).toMatchObject({ tf: '1D' });
    expect(a.showRange).toHaveBeenLastCalledWith('1Y', 'stock');
    // load() runs before showRange (the load drops the adapter's previous range).
    expect(a.load.mock.invocationCallOrder.at(-1)!).toBeLessThan(a.showRange.mock.invocationCallOrder.at(-1)!);
    expect(rangeButton('1Y')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a range whose interval is already shown does not reload; crypto uses the around-the-clock calendar', async () => {
    const v = renderLive({ ...LAYOUT, symbol: 'crypto:BTC', tf: '1D' }, BTC);
    await flush();
    dataIn();
    const loads = adapter().load.mock.calls.length;
    act(() => { fireEvent.click(rangeButton('6M')); });
    expect(v.layout().tf).toBe('1D');
    expect(adapter().load).toHaveBeenCalledTimes(loads);
    expect(adapter().showRange).toHaveBeenLastCalledWith('6M', 'crypto');
    act(() => { fireEvent.click(rangeButton('1D')); });
    expect(v.layout().tf).toBe('5m');
    expect(adapter().showRange).toHaveBeenLastCalledWith('1D', 'crypto');
  });

  it('shows the span of the fitted range next to the buttons while it is selected', async () => {
    renderLive(LAYOUT);
    await flush();
    dataIn();
    const span = screen.getByTestId('range-span');
    expect(span).toHaveAttribute('role', 'status');
    expect(span).toHaveTextContent('');
    act(() => { fireEvent.click(rangeButton('1Y')); });
    act(() => adapter().rangeShownCb!({ preset: '1Y', first: 1, last: 2, bars: 252, label: 'Oct 16, 2025 – Oct 15, 2026' }));
    expect(span).toHaveTextContent('Oct 16, 2025 – Oct 15, 2026');
    act(() => adapter().rangeCanceledCb!());
    expect(span).toHaveTextContent('');
  });

  it('deselects when the user zooms or scrolls (the adapter cancels the range)', async () => {
    renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => { fireEvent.click(rangeButton('5D')); });
    expect(rangeButton('5D')).toHaveAttribute('aria-pressed', 'true');
    act(() => adapter().rangeCanceledCb!());
    expect(rangeButton('5D')).toHaveAttribute('aria-pressed', 'false');
  });

  it('deselects when the interval, session or symbol changes', async () => {
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => { fireEvent.click(rangeButton('1M')); });
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'true');
    act(() => v.rerender({ ...v.layout(), tf: '4h' }));
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'false');
    act(() => v.rerender({ ...v.layout(), tf: '1h' }));
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'false'); // back on 1h: still deselected
    dataIn();
    act(() => { fireEvent.click(rangeButton('1M')); });
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'true');
    act(() => v.rerender({ ...v.layout(), session: 'rth' }));
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'false');
    dataIn();
    act(() => { fireEvent.click(rangeButton('1M')); });
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'true');
    act(() => v.rerender({ ...v.layout(), symbol: 'stock:MSFT' }));
    expect(rangeButton('1M')).toHaveAttribute('aria-pressed', 'false');
  });

  it('All: weekly bars when the history fits the chart, monthly when it is long, weekly when the lookup fails', async () => {
    const bars = (fromYear: number) => Array.from({ length: (2026 - fromYear) * 12 }, (_, i) => ({
      ts: Date.UTC(fromYear, i, 1), open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    const res = (b: ReturnType<typeof bars>) => ({
      symbol: AAPL.id, tf: '1M' as const, session: 'eth' as const, hasMoreBefore: false, stale: false, notices: [], markers: [], bars: b,
    });
    const spy = vi.spyOn(api, 'bars').mockResolvedValueOnce(res(bars(2020)));
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    await act(async () => { fireEvent.click(rangeButton('All')); });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ symbol: AAPL.id, tf: '1M', session: 'eth' }), expect.any(AbortSignal));
    expect(v.layout().tf).toBe('1W'); // ~6 years: ~310 weekly bars on a 1000 px plot
    expect(adapter().showRange).toHaveBeenLastCalledWith('All', 'stock');
    expect(rangeButton('All')).toHaveAttribute('aria-pressed', 'true');
    spy.mockResolvedValueOnce(res(bars(1990)));
    dataIn();
    await act(async () => { fireEvent.click(rangeButton('All')); });
    expect(v.layout().tf).toBe('1M');
    spy.mockRejectedValueOnce(new Error('offline'));
    dataIn();
    await act(async () => { fireEvent.click(rangeButton('All')); });
    expect(v.layout().tf).toBe('1W');
  });

  it('All: a second pick aborts the pending history lookup; unmounting aborts it too', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(v: unknown) => void> = [];
    vi.spyOn(api, 'bars').mockImplementation((_p, signal) => {
      signals.push(signal!);
      return new Promise((r) => { resolvers.push(r); }) as never;
    });
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => { fireEvent.click(rangeButton('All')); });
    act(() => { fireEvent.click(rangeButton('All')); });
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    const empty = { bars: [], hasMoreBefore: false };
    await act(async () => { resolvers[0]!(empty); });
    expect(v.setLayout).not.toHaveBeenCalled(); // the aborted lookup does nothing
    await act(async () => { resolvers[1]!(empty); });
    expect(v.layout().tf).toBe('1W');
    dataIn();
    act(() => { fireEvent.click(rangeButton('All')); });
    act(() => { fireEvent.click(rangeButton('1Y')); }); // any other pick aborts it as well
    expect(signals[2]!.aborted).toBe(true);
    expect(v.layout().tf).toBe('1D');
    dataIn();
    act(() => { fireEvent.click(rangeButton('All')); });
    v.unmount();
    expect(signals[3]!.aborted).toBe(true);
  });

  it('All gives up when the symbol changes during its history lookup', async () => {
    let resolve!: (v: unknown) => void;
    vi.spyOn(api, 'bars').mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);
    const v = renderLive(LAYOUT);
    await flush();
    dataIn();
    act(() => { fireEvent.click(rangeButton('All')); });
    act(() => v.rerender({ ...v.layout(), symbol: 'crypto:BTC' }));
    expect((vi.mocked(api.bars).mock.calls.at(-1)![1] as AbortSignal).aborted).toBe(true);
    await act(async () => { resolve({ bars: [], hasMoreBefore: false }); });
    expect(v.layout().tf).toBe('5m');
    expect(adapter().showRange).not.toHaveBeenCalled();
  });
});

describe('ChartView corporate events', () => {
  const div = { kind: 'dividend' as const, ts: Date.UTC(2026, 7, 10, 13, 30), amount: 0.27 };
  const earn = { kind: 'earnings' as const, ts: Date.UTC(2026, 6, 30, 20, 30), epsActual: 2.02, epsEstimate: 1.89243 };

  it('fetches a stock\'s events and hands them to the chart with the hidden kinds; none for crypto', async () => {
    vi.mocked(api.events).mockResolvedValue({ symbol: 'stock:AAPL', events: [earn, div] });
    const { rerenderWith } = renderView({ ...LAYOUT, hiddenEvents: ['split'] });
    await flush();
    await flush();
    expect(api.events).toHaveBeenCalledWith('stock:AAPL');
    expect(adapter().setEvents).toHaveBeenLastCalledWith([earn, div], ['split']);
    rerenderWith({ ...LAYOUT });
    expect(adapter().setEvents).toHaveBeenLastCalledWith([earn, div], []);
    rerenderWith({ ...LAYOUT, symbol: 'crypto:BTC' }, BTC);
    await flush();
    expect(adapter().setEvents).toHaveBeenLastCalledWith([], []);
    expect(api.events).toHaveBeenCalledTimes(1);
  });

  it('shows a tooltip for the hovered badges and lists the drawn events for screen readers', async () => {
    renderView();
    await flush();
    act(() => adapter().eventsShownCb!([{ barTs: earn.ts, events: [earn] }, { barTs: div.ts, events: [div] }]));
    const list = screen.getByTestId('events-readout');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Earnings, Jul 30, 2026, after the close: EPS 2.02 vs 1.89 estimated, beat by 6.7%',
      'Dividend, Aug 10, 2026: $0.27 per share',
    ]);
    act(() => adapter().eventHoverCb!({ events: [div], x: 300, y: 400 }));
    const tip = document.querySelector('.event-tooltip') as HTMLElement;
    expect(tip).toHaveTextContent('Dividend Aug 10, 2026$0.27 per share');
    expect(tip.style.left).toBe('300px');
    expect(tip.style.top).toBe('400px');
    act(() => adapter().eventHoverCb!(null));
    expect(document.querySelector('.event-tooltip')).toBeNull();
  });
});

describe('sticky drawing style', () => {
  it('hands the layout\'s drawing defaults to the chart (again only when they change)', async () => {
    const drawingDefaults = { size: 3, style: 'dashed' as const };
    const { rerenderWith } = renderView({ ...LAYOUT, drawingDefaults });
    await flush();
    expect(adapter().setNewDrawingDefaults).toHaveBeenLastCalledWith(drawingDefaults);
    const calls = adapter().setNewDrawingDefaults.mock.calls.length;
    rerenderWith({ ...LAYOUT, drawingDefaults: { ...drawingDefaults } });
    expect(adapter().setNewDrawingDefaults).toHaveBeenCalledTimes(calls);
    rerenderWith({ ...LAYOUT });
    expect(adapter().setNewDrawingDefaults).toHaveBeenLastCalledWith(undefined);
  });

  it('mergeDrawingDefaults merges a patch, price labels per tool', () => {
    const cur = { size: 2, labels: { priceLine: { onLine: false, onAxis: true } } };
    expect(mergeDrawingDefaults(cur, { style: 'dotted' })).toEqual({ ...cur, style: 'dotted' });
    expect(mergeDrawingDefaults(cur, { labels: { horizontalStraightLine: { onLine: true, onAxis: true } } })).toEqual({
      size: 2, labels: { priceLine: { onLine: false, onAxis: true }, horizontalStraightLine: { onLine: true, onAxis: true } },
    });
    expect(mergeDrawingDefaults(undefined, { fill: false })).toEqual({ fill: false });
  });
});

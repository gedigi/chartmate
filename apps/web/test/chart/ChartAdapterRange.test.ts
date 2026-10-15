import { nyToUtc, type Bar, type SymbolInfo } from '@chartmate/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ActionCb = (data?: unknown) => void;

const k = vi.hoisted(() => {
  const state = { chart: null as unknown as ReturnType<typeof makeChart> };
  function makeChart() {
    const data: Array<{ timestamp: number }> = [];
    const actions = new Map<string, Set<ActionCb>>();
    const chart = {
      data, actions, width: 1000,
      setStyles: vi.fn(), setFormatter: vi.fn(), overrideXAxis: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(),
      setTimezone: vi.fn(), resetData: vi.fn(), resize: vi.fn(), getDataList: vi.fn(() => data),
      getIndicators: vi.fn(() => []), overrideIndicator: vi.fn(), getOverlays: vi.fn(() => []), createOverlay: vi.fn(), removeOverlay: vi.fn(),
      overrideOverlay: vi.fn(),
      setBarSpace: vi.fn(), setOffsetRightDistance: vi.fn(),
      getSize: vi.fn((paneId?: string, pos?: string) => (paneId === 'candle_pane' && pos === 'main' ? { width: chart.width, height: 400 } : null)),
      subscribeAction: vi.fn((type: string, cb: ActionCb) => {
        if (!actions.has(type)) actions.set(type, new Set());
        actions.get(type)!.add(cb);
      }),
      unsubscribeAction: vi.fn((type: string, cb?: ActionCb) => {
        if (cb) actions.get(type)?.delete(cb);
        else actions.delete(type);
      }),
      fire: (type: string) => { for (const cb of actions.get(type) ?? []) cb({}); },
    };
    return chart;
  }
  return { state, init: vi.fn(() => { state.chart = makeChart(); return state.chart; }) };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: vi.fn(),
  registerIndicator: vi.fn(),
  registerOverlay: vi.fn(),
  getOverlayClass: () => null,
  getSupportedIndicators: () => [],
}));

const { ChartAdapter, MAX_HISTORY_PAGES } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const events = () => ({ onMeta: vi.fn(), onError: vi.fn(), onConnection: vi.fn() });
const chart = () => k.state.chart;
const DAY = 86_400_000;
const MIN = 60_000;

const bar = (ts: number): Bar => ({ ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const response = (symbol: SymbolInfo, bars: Bar[], hasMoreBefore: boolean) => ({
  symbol: symbol.id, tf: '1D' as const, session: 'rth' as const, hasMoreBefore, stale: false, notices: [], markers: [], bars,
});
type Loader = { getBars: (p: unknown) => Promise<void> };
const loader = () => chart().setDataLoader.mock.calls.at(-1)![0] as Loader;

let el: HTMLElement;
beforeEach(() => {
  vi.restoreAllMocks();
  el = document.createElement('div');
});

/** Loads `bars` as the init page (KLineChart: replaces the data, then `ready`). */
async function loadWith(symbol: SymbolInfo, tf: '1D' | '5m', bars: Bar[], hasMoreBefore = false) {
  const a = new ChartAdapter(el, { theme: 'dark' });
  a.load({ symbol, tf, session: 'rth', pollMs: 15000 }, events());
  vi.spyOn(api, 'bars').mockResolvedValue(response(symbol, bars, hasMoreBefore));
  await loader().getBars({
    type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: tf === '1D' ? { type: 'day', span: 1 } : { type: 'minute', span: 5 },
    callback: (d: Array<{ timestamp: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
  });
  return a;
}

const weekdays = (from: number, to: number) => {
  const out: Bar[] = [];
  for (let t = from; t <= to; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(bar(t));
  return out;
};

describe('ChartAdapter.showRange', () => {
  it('fits the range\'s bars to the plot width, ending at the latest bar', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2023, 0, 2), Date.UTC(2026, 9, 15)));
    a.showRange('1Y', 'stock');
    // 261 sessions from Oct 16 2025 to Oct 15 2026 over 1000 px minus the 80 px right margin.
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 261);
    expect(chart().setOffsetRightDistance).toHaveBeenLastCalledWith(80);
  });

  it('waits for the data of the current load before fitting', async () => {
    const a = new ChartAdapter(el, { theme: 'dark' });
    a.load({ symbol: AAPL, tf: '5m', session: 'rth', pollMs: 15000 }, events());
    a.showRange('1D', 'stock');
    expect(chart().setBarSpace).not.toHaveBeenCalled();
    const day = nyToUtc(2026, 10, 15, 9, 30);
    const bars = [...Array.from({ length: 78 }, (_, i) => bar(day - DAY + i * 5 * MIN)), ...Array.from({ length: 78 }, (_, i) => bar(day + i * 5 * MIN))];
    vi.spyOn(api, 'bars').mockResolvedValue(response(AAPL, bars, false));
    await loader().getBars({
      type: 'init', timestamp: null, symbol: { ticker: AAPL.id }, period: { type: 'minute', span: 5 },
      callback: (d: Array<{ timestamp: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
    });
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 78);
  });

  it('requests older pages until the range is covered, then fits', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2026, 5, 1), Date.UTC(2026, 9, 15)), true);
    const store = { _dataLoadMore: { forward: true }, _loading: false, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    a.showRange('1Y', 'stock');
    expect(store._processDataLoad).toHaveBeenCalledWith('forward');
    expect(chart().setBarSpace).not.toHaveBeenCalled();
    vi.spyOn(api, 'bars').mockResolvedValue(response(AAPL, weekdays(Date.UTC(2025, 0, 1), Date.UTC(2026, 4, 31)), false));
    await loader().getBars({
      type: 'forward', timestamp: Date.UTC(2026, 5, 1), symbol: { ticker: AAPL.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number }>) => { chart().data.unshift(...d); store._dataLoadMore.forward = false; },
    });
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 261);
  });

  it('reports the bars it shows and their span (the newest that fit when there are too many)', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2023, 0, 2), Date.UTC(2026, 9, 15)));
    const shown = vi.fn();
    a.onRangeShown(shown);
    a.showRange('1Y', 'stock');
    expect(shown).toHaveBeenLastCalledWith({
      preset: '1Y', first: Date.UTC(2025, 9, 16), last: Date.UTC(2026, 9, 15), bars: 261, label: 'Oct 16, 2025 – Oct 15, 2026',
    });
    chart().width = 300; // 220 px for 261 bars at 1 px at least: the newest 220
    a.resize();
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({ bars: 220, last: Date.UTC(2026, 9, 15) }));
  });

  it('older pages for ranges are capped per load, however often a range is picked', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 15)), true);
    const store = { _dataLoadMore: { forward: true }, _loading: false, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    for (let i = 0; i < 100; i++) a.showRange('All', 'stock'); // each pick asks for a page (none ever arrives)
    expect(store._processDataLoad.mock.calls.length).toBe(MAX_HISTORY_PAGES);
    expect(chart().setBarSpace).toHaveBeenCalled(); // past the cap it fits what is loaded
  });

  describe('live bars', () => {
    /** Subscribes like KLineChart after the init page: polled bars are appended (or replace the forming one). */
    function subscribe() {
      const l = chart().setDataLoader.mock.calls.at(-1)![0] as { subscribeBar: (p: unknown) => void };
      l.subscribeBar({
        symbol: { ticker: AAPL.id }, period: { type: 'minute', span: 5 },
        callback: (bar: { timestamp: number }) => {
          if (chart().data.at(-1)?.timestamp === bar.timestamp) chart().data[chart().data.length - 1] = bar;
          else chart().data.push(bar);
        },
      });
    }
    const latest = (b: Bar) => vi.spyOn(api, 'latest').mockResolvedValue({ bar: b, stale: false });

    it('a new bar refits the active range (a new session for 1D) and updates its span, never deselecting it', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const open = nyToUtc(2025, 10, 14, 9, 30);
        const a = await loadWith(AAPL, '5m', Array.from({ length: 78 }, (_, i) => bar(open + i * 5 * MIN)));
        const shown = vi.fn();
        const canceled = vi.fn();
        a.onRangeShown(shown);
        a.onRangeCanceled(canceled);
        a.showRange('1D', 'stock');
        expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 78);
        subscribe();
        // The next session opens: one bar of Oct 15 (too few alone, so Oct 14 stays in view).
        const next = nyToUtc(2025, 10, 15, 9, 30);
        latest(bar(next));
        vi.spyOn(api, 'bars').mockResolvedValue(response(AAPL, [], false));
        await vi.advanceTimersByTimeAsync(15000);
        expect(chart().data.at(-1)!.timestamp).toBe(next);
        expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 79);
        expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({ last: next, bars: 79, label: 'Oct 14, 09:30 – Oct 15, 09:30' }));
        // An update of the forming bar (same time): nothing to refit.
        chart().setBarSpace.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(chart().setBarSpace).not.toHaveBeenCalled();
        expect(canceled).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('without an active range new bars leave the view alone', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const open = nyToUtc(2025, 10, 14, 9, 30);
        const a = await loadWith(AAPL, '5m', Array.from({ length: 78 }, (_, i) => bar(open + i * 5 * MIN)));
        a.showRange('1D', 'stock');
        chart().fire('onScroll'); // the user scrolled: no range any more
        chart().setBarSpace.mockClear();
        subscribe();
        latest(bar(nyToUtc(2025, 10, 15, 9, 30)));
        vi.spyOn(api, 'bars').mockResolvedValue(response(AAPL, [], false));
        await vi.advanceTimersByTimeAsync(15000);
        expect(chart().setBarSpace).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('a short history fits every bar', async () => {
    const bars = weekdays(Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 15));
    const a = await loadWith(AAPL, '1D', bars);
    a.showRange('1Y', 'stock');
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / bars.length);
  });

  it('crypto 1D: the last 24 hours of 5m bars', async () => {
    const latest = Date.UTC(2025, 9, 18, 12, 0); // in the past: the loader drops bars after now
    const bars = Array.from({ length: 600 }, (_, i) => bar(latest - (599 - i) * 5 * MIN));
    const a = await loadWith(BTC, '5m', bars);
    a.showRange('1D', 'crypto');
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(920 / 288);
  });

  it('a user zoom or scroll cancels the range (listeners told once); fitting itself does not', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2023, 0, 2), Date.UTC(2026, 9, 15)));
    const canceled = vi.fn();
    a.onRangeCanceled(canceled);
    a.showRange('6M', 'stock');
    expect(canceled).not.toHaveBeenCalled();
    chart().fire('onZoom');
    expect(canceled).toHaveBeenCalledTimes(1);
    chart().fire('onScroll');
    expect(canceled).toHaveBeenCalledTimes(1);
    a.showRange('6M', 'stock');
    chart().fire('onScroll');
    expect(canceled).toHaveBeenCalledTimes(2);
  });

  it('resizing re-fits an active range; once canceled it does not', async () => {
    const a = await loadWith(AAPL, '1D', weekdays(Date.UTC(2023, 0, 2), Date.UTC(2026, 9, 15)));
    a.showRange('1Y', 'stock');
    chart().width = 600;
    a.resize();
    expect(chart().setBarSpace).toHaveBeenLastCalledWith(520 / 261);
    chart().fire('onZoom');
    chart().setBarSpace.mockClear();
    a.resize();
    expect(chart().setBarSpace).not.toHaveBeenCalled();
  });

  it('a new load drops a pending range', async () => {
    const a = new ChartAdapter(el, { theme: 'dark' });
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
    a.showRange('1Y', 'stock');
    a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 5000 }, events());
    vi.spyOn(api, 'bars').mockResolvedValue(response(BTC, weekdays(Date.UTC(2023, 0, 2), Date.UTC(2026, 9, 15)), false));
    await loader().getBars({
      type: 'init', timestamp: null, symbol: { ticker: BTC.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
    });
    expect(chart().setBarSpace).not.toHaveBeenCalled();
  });

  it('plotWidth reads the price pane\'s plot width', async () => {
    const a = new ChartAdapter(el, { theme: 'dark' });
    expect(a.plotWidth()).toBe(1000);
  });

  it('destroy unsubscribes from the chart\'s zoom and scroll', () => {
    const a = new ChartAdapter(el, { theme: 'dark' });
    a.destroy();
    expect(chart().actions.get('onZoom')?.size ?? 0).toBe(0);
    expect(chart().actions.get('onScroll')?.size ?? 0).toBe(0);
  });
});

import type { SymbolInfo } from '@chartmate/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOverlay {
  id: string; name: string; groupId: string; points: Array<{ timestamp: number; value: number }>; lock: boolean;
  extendData: unknown; styles: unknown; onRemoved?: (e: unknown) => void; onDrawEnd?: (e: unknown) => void; onPressedMoveEnd?: (e: unknown) => void;
  onSelected?: (e: unknown) => void; onDeselected?: (e: unknown) => void; mode?: string;
}
interface FakeIndicator { id: string; name: string; paneId: string; calcParams: number[]; visible: boolean; styles: unknown }

const k = vi.hoisted(() => {
  const state = { chart: null as unknown as ReturnType<typeof makeChart>, registered: [] as string[], overlayTemplates: [] as any[] };
  function makeChart() {
    let seq = 0;
    const overlays: FakeOverlay[] = [];
    const indicators: FakeIndicator[] = [];
    const data: Array<{ timestamp: number; high: number }> = [];
    const chart = {
      overlays, indicators, data,
      setStyles: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), setTimezone: vi.fn(), resetData: vi.fn(),
      resize: vi.fn(), getDataList: vi.fn(() => data),
      getStyles: vi.fn(() => ({
        indicator: {
          lines: [{ color: '#d1', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }, { color: '#d2', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }, { color: '#d3', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }],
          bars: [{ style: 'fill', borderStyle: 'solid', borderSize: 1, borderDashedValue: [2, 2], upColor: 'rgba(45,192,142,0.7)', downColor: 'rgba(249,40,85,0.7)', noChangeColor: '#76808F' }],
        },
        overlay: { line: { style: 'solid', smooth: false, color: '#1677FF', size: 1, dashedValue: [2, 2] }, text: { color: '#FFFFFF', size: 12, backgroundColor: '#1677FF' } },
      })),
      createIndicator: vi.fn((v: Partial<FakeIndicator> & { name: string }, _isStack?: boolean) => {
        const id = `ind_${++seq}`;
        indicators.push({ id, paneId: v.paneId ?? `pane_${seq}`, calcParams: v.calcParams ?? [], visible: v.visible ?? true, styles: v.styles ?? null, name: v.name });
        return id;
      }),
      overrideIndicator: vi.fn((o: Partial<FakeIndicator>) => {
        const ind = indicators.find((i) => i.id === o.id);
        if (ind) Object.assign(ind, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
        return true;
      }),
      removeIndicator: vi.fn((f: { id?: string; name?: string }) => {
        for (let i = indicators.length - 1; i >= 0; i--) {
          const ind = indicators[i]!;
          if ((f.id && ind.id === f.id) || (f.name && ind.name === f.name)) indicators.splice(i, 1);
        }
        return true;
      }),
      getIndicators: vi.fn((f?: { name?: string }) => indicators.filter((i) => !f?.name || i.name === f.name)),
      createOverlay: vi.fn((v: Partial<FakeOverlay> & { name: string }) => {
        const id = `ov_${++seq}`;
        overlays.push({ id, groupId: v.groupId ?? '', points: v.points ?? [], lock: v.lock ?? false, extendData: v.extendData, styles: v.styles ?? null, ...v, name: v.name } as FakeOverlay);
        return id;
      }),
      getOverlays: vi.fn((f?: { groupId?: string }) => overlays.filter((o) => !f?.groupId || o.groupId === f.groupId)),
      overrideOverlay: vi.fn((o: Partial<FakeOverlay>) => {
        const ov = overlays.find((x) => x.id === o.id);
        if (ov) Object.assign(ov, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
        return true;
      }),
      removeOverlay: vi.fn((f: { id?: string; groupId?: string }) => {
        for (let i = overlays.length - 1; i >= 0; i--) {
          const o = overlays[i]!;
          if ((f.id && o.id === f.id) || (f.groupId && o.groupId === f.groupId)) {
            o.onRemoved?.({ overlay: o }); // like KLineChart: onRemoved fires while the overlay is still listed
            overlays.splice(i, 1);
          }
        }
        return true;
      }),
    };
    return chart;
  }
  return {
    state,
    makeChart,
    init: vi.fn(() => { state.chart = makeChart(); return state.chart; }),
    dispose: vi.fn(),
    registerIndicator: vi.fn((t: { name: string }) => { state.registered.push(t.name); }),
    registerOverlay: vi.fn((t: { name: string }) => { state.overlayTemplates.push(t); }),
  };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: k.dispose,
  registerIndicator: k.registerIndicator,
  registerOverlay: k.registerOverlay,
  getOverlayClass: () => null,
  getSupportedIndicators: () => k.state.registered,
}));

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const events = () => ({ onMeta: vi.fn(), onError: vi.fn(), onConnection: vi.fn() });

let el: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  el = document.createElement('div');
});
const make = () => new ChartAdapter(el, { theme: 'dark' });
const chart = () => k.state.chart;

const { POSITION_STYLE_KEY, positionContext } = await import('../../src/chart/positionOverlay');

describe('ChartAdapter long / short positions', () => {
  const DAY = 86_400_000;
  const D1 = Date.UTC(2024, 2, 4); // Mon
  const OPEN1 = Date.UTC(2024, 2, 4, 14, 30); // 09:30 New York
  const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
  const defaults = { accountSize: 20000, riskMode: 'amount' as const, riskValue: 100, currency: 'EUR' };
  const bars = Array.from({ length: 5 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

  async function loadAt(symbol: SymbolInfo, tf: '1D' | '1h') {
    const a = make();
    a.load({ symbol, tf, session: 'rth', pollMs: 15000 }, events());
    vi.spyOn(api, 'bars').mockResolvedValue({ symbol: symbol.id, tf, session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({
      type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
    });
    return a;
  }
  const select = (o: FakeOverlay) => o.onSelected?.({ overlay: o });
  const position = (over: Partial<{ entry: number; target: number; stop: number; start: number; end: number }> = {}) => {
    const p = { start: D1, end: D1 + 20 * DAY, entry: 100, target: 102, stop: 98, ...over };
    return [
      { timestamp: p.start, value: p.entry }, { timestamp: p.start, value: p.target }, { timestamp: p.start, value: p.stop }, { timestamp: p.end, value: p.entry },
    ];
  };
  type Pressable = FakeOverlay & { onPressedMoveStart?: (e: unknown) => void };

  it('placing a long position: one click at the entry (rounded), ±2 % target / stop, ≈ 20 bars wide, default risk settings snapshotted', async () => {
    const a = await loadAt(BTC, '1D');
    a.setPositionDefaults(defaults);
    const onEnd = vi.fn();
    a.startDrawing('longPosition', { onEnd });
    const o = userOverlays().at(-1)!;
    expect(o.name).toBe('longPosition');
    // KLineChart: the click sets point 0, the template previews the rest.
    o.points = [{ timestamp: D1 + DAY, value: 100.004 }, { timestamp: D1 + DAY, value: 102.1 }, { timestamp: D1 + DAY, value: 97.9 }, { timestamp: D1, value: 100.004 }];
    o.onDrawEnd?.({ overlay: o });
    expect(onEnd).toHaveBeenCalled();
    // 3 bars of data after the entry bar, then extrapolated by the timeframe: entry + 20 days.
    expect(o.points).toEqual(position({ start: D1 + DAY, end: D1 + 21 * DAY }));
    expect(a.serializeDrawings()).toEqual([{ name: 'longPosition', points: position({ start: D1 + DAY, end: D1 + 21 * DAY }), lock: false, styles: { position: defaults } }]);
  });

  it('short position: target below, stop above', async () => {
    const a = await loadAt(BTC, '1D');
    a.startDrawing('shortPosition');
    const o = userOverlays().at(-1)!;
    o.points = [{ timestamp: D1, value: 50 }];
    o.onDrawEnd?.({ overlay: o });
    expect(o.points.map((p) => p.value)).toEqual([50, 49, 51, 50]);
    expect(a.serializeDrawings()[0]!.styles).toEqual({ position: { accountSize: 10000, riskMode: 'percent', riskValue: 1, currency: 'USD' } });
  });

  it('serialize / restore round-trip (own settings, lock, anchorTf)', async () => {
    const a = await loadAt(AAPL, '1D');
    const saved = [
      { name: 'longPosition', points: position(), lock: false, anchorTf: '1D' as const, styles: { position: { riskValue: 2, currency: 'CHF' } } },
      { name: 'shortPosition', points: position({ target: 95, stop: 101 }), lock: true },
    ];
    a.restoreDrawings(saved, AAPL.id);
    expect(userOverlays()[0]!.styles).toEqual({ [POSITION_STYLE_KEY]: { riskValue: 2, currency: 'CHF' } });
    expect(a.serializeDrawings()).toEqual(saved);
  });

  it('a daily-anchored position is shown at 09:30 New York on intraday charts and saved unchanged', async () => {
    const a = await loadAt(AAPL, '1h');
    const saved = { name: 'longPosition', points: position({ end: D1 + 2 * DAY }), lock: false, anchorTf: '1D' as const };
    a.restoreDrawings([saved], AAPL.id);
    expect(userOverlays()[0]!.points.map((p) => p.timestamp)).toEqual([OPEN1, OPEN1, OPEN1, Date.UTC(2024, 2, 6, 14, 30)]);
    expect(a.serializeDrawings()).toEqual([saved]);
    // Typing a precise price keeps the stored daily times and the anchor.
    select(userOverlays()[0]!);
    expect(a.setSelectedPositionPrices({ target: 103.5 })).toBeNull();
    expect(a.serializeDrawings()).toEqual([{ ...saved, points: position({ end: D1 + 2 * DAY, target: 103.5 }) }]);
  });

  it('getSelectedDrawing: position kind with prices, precision, settings, metrics and outcome', async () => {
    const a = await loadAt(AAPL, '1D');
    a.setPositionDefaults(defaults);
    a.restoreDrawings([{ name: 'longPosition', points: position({ target: 100.5 }), lock: false }]);
    select(userOverlays()[0]!);
    expect(a.getSelectedDrawing()).toEqual({
      id: userOverlays()[0]!.id, kind: 'position', side: 'long', locked: false, entry: 100, target: 100.5, stop: 98, precision: 2,
      settings: defaults, metrics: { qty: 50, riskAmount: 100, rewardAmount: 25, rr: 0.25, targetPct: 0.5, stopPct: 2 },
      // Bar 2 (high 101) reaches the target.
      // Filled on the start bar (it touches 100); bar 2 (high 101) then reaches the target.
      outcome: { kind: 'target', fillTs: D1, ts: D1 + DAY, price: 100.5, pnl: 25, pnlPct: 0.5 },
    });
  });

  it('setSelectedPositionPrices validates the sides and rounds to the precision; changes are saved', async () => {
    const a = await loadAt(AAPL, '1D');
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    a.restoreDrawings([{ name: 'longPosition', points: position(), lock: false }]);
    const o = userOverlays()[0]!;
    select(o);
    expect(a.setSelectedPositionPrices({ target: 99 })).toMatch(/target/i);
    expect(a.setSelectedPositionPrices({ stop: 100 })).toMatch(/stop/i);
    expect(changed).not.toHaveBeenCalled();
    expect(a.setSelectedPositionPrices({ entry: 99.004, stop: 97 })).toBeNull();
    expect(o.points).toEqual(position({ entry: 99, stop: 97 }));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('setSelectedPositionSettings stores the position\'s own risk settings; locked positions are read-only', async () => {
    const a = await loadAt(AAPL, '1D');
    a.restoreDrawings([{ name: 'longPosition', points: position(), lock: false }, { name: 'shortPosition', points: position({ target: 98, stop: 102 }), lock: true }]);
    const [free, locked] = userOverlays();
    select(free!);
    a.setSelectedPositionSettings({ riskMode: 'amount', riskValue: 300 });
    expect(a.getSelectedDrawing()).toMatchObject({ settings: { accountSize: 10000, riskMode: 'amount', riskValue: 300, currency: 'USD' }, metrics: { qty: 150 } });
    expect(a.serializeDrawings()[0]!.styles).toEqual({ position: { riskMode: 'amount', riskValue: 300 } });
    select(locked!);
    expect(a.setSelectedPositionPrices({ target: 97 })).toMatch(/locked/i);
    chart().overrideOverlay.mockClear();
    a.setSelectedPositionSettings({ riskValue: 5 });
    expect(chart().overrideOverlay).not.toHaveBeenCalled();
  });

  it('a whole-position drag (KLineChart shifts every point) is rounded to the precision at the end', async () => {
    const a = await loadAt(AAPL, '1D');
    a.restoreDrawings([{ name: 'longPosition', points: position(), lock: false }]);
    const o = userOverlays()[0]! as Pressable;
    o.onPressedMoveStart?.({ overlay: o });
    o.points = position({ entry: 100.123, target: 102.123, stop: 98.123, start: D1 + DAY, end: D1 + 21 * DAY });
    o.onPressedMoveEnd?.({ overlay: o });
    expect(a.serializeDrawings()[0]!.points).toEqual(position({ entry: 100.12, target: 102.12, stop: 98.12, start: D1 + DAY, end: D1 + 21 * DAY }));
  });

  it('dragging an edge of the selected position refreshes the style bar selection', async () => {
    const a = await loadAt(AAPL, '1D');
    const selection = vi.fn();
    a.onSelectionChange(selection);
    a.restoreDrawings([{ name: 'longPosition', points: position(), lock: false }]);
    const o = userOverlays()[0]! as Pressable;
    select(o);
    o.onPressedMoveStart?.({ overlay: o });
    o.points[1]!.value = 105; // KLineChart moves the point in place
    o.onPressedMoveEnd?.({ overlay: o });
    expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'position', target: 105 }));
  });

  it('a press without movement keeps a daily-anchored position as stored', async () => {
    const a = await loadAt(AAPL, '1h');
    const saved = { name: 'longPosition', points: position(), lock: false, anchorTf: '1D' as const };
    a.restoreDrawings([saved], AAPL.id);
    const o = userOverlays()[0]! as Pressable;
    o.onPressedMoveStart?.({ overlay: o });
    o.points = o.points.map((p) => ({ ...p }));
    o.onPressedMoveEnd?.({ overlay: o });
    expect(a.serializeDrawings()).toEqual([saved]);
  });

  it('sets the overlay context per load / theme: bar duration, quantity decimals, colors, defaults', async () => {
    const a = await loadAt(BTC, '1h');
    expect(positionContext.barMs).toBe(3_600_000);
    expect(positionContext.qtyDecimals).toBe(6);
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
    expect(positionContext.barMs).toBe(DAY);
    expect(positionContext.qtyDecimals).toBe(0);
    a.setTheme('light');
    expect(positionContext.colors.up).toBe('#00a870');
    a.setPositionDefaults(undefined);
    expect(positionContext.defaults).toEqual({ accountSize: 10000, riskMode: 'percent', riskValue: 1, currency: 'USD' });
  });

  it('a position starting before the loaded bars: "needs earlier data" while older pages exist, which are requested', async () => {
    const a = await loadAt(BTC, '1D');
    const store = { _dataLoadMore: { forward: true }, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    a.restoreDrawings([{ name: 'longPosition', points: position({ start: D1 - 10 * DAY, end: D1 + 2 * DAY }), lock: false }]);
    select(userOverlays()[0]!);
    expect(a.getSelectedDrawing()).toMatchObject({ outcome: { kind: 'needsData' } });
    expect(store._processDataLoad).toHaveBeenCalledWith('forward');
    // The older page arrives (KLineChart prepends it): recomputed, and no further page is needed.
    vi.spyOn(api, 'bars').mockResolvedValue({
      symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
      bars: [{ ts: D1 - 10 * DAY, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }],
    });
    const selection = vi.fn();
    a.onSelectionChange(selection);
    store._processDataLoad.mockClear();
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({
      type: 'forward', timestamp: D1, symbol: { ticker: BTC.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.unshift(...(d as never[])); store._dataLoadMore.forward = false; },
    });
    expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ kind: 'ended', fillTs: D1 - 10 * DAY }) }));
    expect(store._processDataLoad).not.toHaveBeenCalled();
  });

  it('older pages are requested a bounded number of times per load', async () => {
    const a = await loadAt(BTC, '1D');
    const store = { _dataLoadMore: { forward: true }, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    a.restoreDrawings([{ name: 'longPosition', points: position({ start: D1 - 1000 * DAY }), lock: false }]);
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: true, stale: false, notices: [], markers: [], bars: [] });
    for (let i = 0; i < 100; i++) {
      await loader.getBars({ type: 'forward', timestamp: D1, symbol: { ticker: BTC.id }, period: { type: 'day', span: 1 }, callback: () => {} });
    }
    expect(store._processDataLoad.mock.calls.length).toBeLessThanOrEqual(40);
  });

  it('bar helpers in the overlay context use the loaded bars: next bar, shift by bars, default end', async () => {
    await loadAt(AAPL, '1D');
    expect(positionContext.minEnd(D1 + 4 * DAY)).toBe(D1 + 5 * DAY);
    expect(positionContext.minEnd(D1)).toBe(D1 + DAY);
    expect(positionContext.shiftEnd(D1 + 3 * DAY, D1, D1 + DAY)).toBe(D1 + 4 * DAY);
    expect(positionContext.endFor(D1)).toBe(D1 + 20 * DAY);
  });

  it('a whole-position drag that takes a price to zero or below is undone', async () => {
    const a = await loadAt(AAPL, '1D');
    a.restoreDrawings([{ name: 'longPosition', points: position(), lock: false }]);
    const o = userOverlays()[0]! as Pressable;
    o.onPressedMoveStart?.({ overlay: o });
    o.points = position({ entry: 1, target: 3, stop: -1 });
    o.onPressedMoveEnd?.({ overlay: o });
    expect(a.serializeDrawings()[0]!.points).toEqual(position());
  });

  it('paging: a request skipped while KLineChart is already loading does not count toward the cap', async () => {
    const a = await loadAt(BTC, '1D');
    const store = { _loading: true, _dataLoadMore: { forward: true }, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    a.restoreDrawings([{ name: 'longPosition', points: position({ start: D1 - 1000 * DAY }), lock: false }]);
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: true, stale: false, notices: [], markers: [], bars: [] });
    const page = () => loader.getBars({ type: 'forward', timestamp: D1, symbol: { ticker: BTC.id }, period: { type: 'day', span: 1 }, callback: () => {} });
    for (let i = 0; i < 60; i++) await page();
    expect(store._processDataLoad).not.toHaveBeenCalled();
    store._loading = false;
    await page();
    expect(store._processDataLoad).toHaveBeenCalledTimes(1);
  });

  it('paging: after a failed older page, no new page until the next successful data (or a new load)', async () => {
    const a = await loadAt(BTC, '1D');
    const store = { _dataLoadMore: { forward: true }, _processDataLoad: vi.fn() };
    (chart() as unknown as { getChartStore: () => typeof store }).getChartStore = () => store;
    a.restoreDrawings([{ name: 'longPosition', points: position({ start: D1 - 1000 * DAY }), lock: false }]);
    expect(store._processDataLoad).toHaveBeenCalledTimes(1);
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    const page = () => loader.getBars({ type: 'forward', timestamp: D1, symbol: { ticker: BTC.id }, period: { type: 'day', span: 1 }, callback: () => {} });
    vi.spyOn(api, 'bars').mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 5; i++) await page();
    expect(store._processDataLoad).toHaveBeenCalledTimes(1);
    vi.spyOn(api, 'bars').mockResolvedValue({
      symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: true, stale: false, notices: [], markers: [],
      bars: [{ ts: D1 - DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    });
    await page();
    expect(store._processDataLoad).toHaveBeenCalledTimes(2);
  });
});

import type { SymbolInfo } from '@altv/shared';
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

describe('ChartAdapter', () => {
  it('inits the chart with theme styles and registers SESSION_SHADE once', () => {
    make();
    make();
    expect(k.init).toHaveBeenCalledWith(el, expect.objectContaining({ styles: expect.any(Object) }));
    expect(k.registerIndicator.mock.calls.filter(([t]) => t.name === 'SESSION_SHADE')).toHaveLength(1);
  });

  it('load sets symbol (ticker = SymbolId, precisions), period and a data loader', () => {
    const a = make();
    a.load({ symbol: AAPL, tf: '5m', session: 'eth', pollMs: 15000 }, events());
    expect(chart().setSymbol).toHaveBeenCalledWith(expect.objectContaining({ ticker: 'stock:AAPL', pricePrecision: 2, volumePrecision: 0, displayName: 'AAPL', tf: '5m' }));
    expect(chart().setPeriod).toHaveBeenCalledWith({ type: 'minute', span: 5 });
    expect(chart().setDataLoader).toHaveBeenCalledWith(expect.objectContaining({ getBars: expect.any(Function), subscribeBar: expect.any(Function) }));
    a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 5000 }, events());
    expect(chart().setSymbol).toHaveBeenLastCalledWith(expect.objectContaining({ ticker: 'crypto:BTC', pricePrecision: 2, volumePrecision: 4 }));
  });

  /** Runs the loader installed by setDataLoader call `i` for 'init' and returns what it called back with. */
  async function runInit(i: number) {
    const loader = chart().setDataLoader.mock.calls[i]![0] as { getBars: (p: unknown) => Promise<void> | void };
    const callback = vi.fn();
    await loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'x' }, period: { type: 'day', span: 1 }, callback });
    return callback;
  }

  it('load blanks the chart first (an empty-init loader) so old data never shows under the new symbol', async () => {
    const a = make();
    a.load({ symbol: AAPL, tf: '5m', session: 'eth', pollMs: 15000 }, events());
    const calls = chart().setDataLoader.mock.calls;
    expect(calls).toHaveLength(2);
    expect(await runInit(0)).toHaveBeenCalledWith([], { forward: false, backward: false });
    expect(calls[0]![0]).not.toHaveProperty('subscribeBar');
  });

  it('clear() stops the current loader and blanks the chart', async () => {
    const a = make();
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
    const real = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    const bars = vi.spyOn(api, 'bars');
    a.clear();
    expect(await runInit(chart().setDataLoader.mock.calls.length - 1)).toHaveBeenCalledWith([], { forward: false, backward: false });
    const cb = vi.fn();
    await real.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period: { type: 'day', span: 1 }, callback: cb });
    expect(bars).not.toHaveBeenCalled(); // the disposed loader is inert
    expect(cb).not.toHaveBeenCalled();
  });

  it('a poll gap too large to backfill resets the chart data (full reload)', async () => {
    vi.useFakeTimers();
    try {
      const a = make();
      a.load({ symbol: BTC, tf: '1m', session: 'rth', pollMs: 5000 }, events());
      const loader = chart().setDataLoader.mock.calls.at(-1)![0] as {
        getBars: (p: unknown) => Promise<void>; subscribeBar: (p: unknown) => void;
      };
      const now = Date.now();
      vi.spyOn(api, 'bars').mockResolvedValue({
        symbol: 'crypto:BTC', tf: '1m', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
        bars: [{ ts: now - 10 * 86_400_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      });
      await loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'crypto:BTC' }, period: { type: 'minute', span: 1 }, callback: vi.fn() });
      vi.spyOn(api, 'latest').mockResolvedValue({ bar: { ts: now, open: 1, high: 1, low: 1, close: 1, volume: 1 }, stale: false });
      loader.subscribeBar({ symbol: { ticker: 'crypto:BTC' }, period: { type: 'minute', span: 1 }, callback: vi.fn() });
      await vi.advanceTimersByTimeAsync(5000);
      expect(chart().resetData).toHaveBeenCalledTimes(1);
      a.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('addIndicator main → candle_pane with isStack=true; sub → new pane', () => {
    const a = make();
    const id = a.addIndicator({ name: 'MA', pane: 'main', calcParams: [20] });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'MA', paneId: 'candle_pane', calcParams: [20] }), true);
    a.addIndicator({ name: 'RSI', pane: 'sub' });
    const [arg, stack] = chart().createIndicator.mock.calls.at(-1)!;
    expect(arg.paneId).toBeUndefined();
    expect(stack).toBeFalsy();
    expect(a.listIndicators()).toEqual([
      expect.objectContaining({ id, name: 'MA', pane: 'main', calcParams: [20] }),
      expect.objectContaining({ name: 'RSI', pane: 'sub' }),
    ]);
  });

  it('updateIndicator overrides; removeIndicator removes; SESSION_SHADE is not listed', () => {
    const a = make();
    a.setSessionShading(true);
    const id = a.addIndicator({ name: 'MA', pane: 'main', calcParams: [20] });
    a.updateIndicator(id, { calcParams: [50], visible: false, lineColors: ['#fff'] });
    expect(chart().overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({
      id, calcParams: [50], visible: false, styles: { lines: [expect.objectContaining({ color: '#fff', size: 1, style: 'solid' })] },
    }));
    expect(a.listIndicators()).toEqual([expect.objectContaining({ id, calcParams: [50], visible: false, lineColors: ['#fff'] })]);
    a.removeIndicator(id);
    expect(a.listIndicators()).toEqual([]);
  });

  it('updateIndicator without lineColors resets a previous colour override to the default line colours', () => {
    const a = make();
    const id = a.addIndicator({ name: 'MA', pane: 'main', calcParams: [20], lineColors: ['#fff'] });
    a.updateIndicator(id, { calcParams: [30] });
    expect(chart().overrideIndicator).toHaveBeenLastCalledWith(expect.objectContaining({
      id, calcParams: [30], styles: { lines: ['#d1', '#d2', '#d3'].map((color) => expect.objectContaining({ color, size: 1, style: 'solid' })) },
    }));
    expect(a.listIndicators()[0]!.lineColors).toBeUndefined();
    chart().overrideIndicator.mockClear();
    a.updateIndicator(id, { visible: false });
    expect(chart().overrideIndicator.mock.calls[0]![0]).not.toHaveProperty('styles');
  });

  it('registers the custom VWAP/ATR indicators and passes symbol/timeframe context via extendData', () => {
    const a = make();
    expect(k.state.registered).toEqual(expect.arrayContaining(['VWAP', 'ATR']));
    const early = a.addIndicator({ name: 'VWAP', pane: 'main' });
    const atrId = a.addIndicator({ name: 'ATR', pane: 'sub' });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'ATR', precision: 4 }), false);
    a.setSessionShading(true);
    a.load({ symbol: AAPL, tf: '5m', session: 'rth', pollMs: 15000 }, events());
    const stock5m = { assetClass: 'stock', intraday: true, pricePrecision: 2 };
    expect(chart().overrideIndicator).toHaveBeenCalledWith({ id: early, name: 'VWAP', extendData: stock5m });
    expect(chart().overrideIndicator).toHaveBeenCalledWith({ id: atrId, name: 'ATR', extendData: stock5m, precision: 2 });
    expect(chart().overrideIndicator).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'SESSION_SHADE' }));
    a.addIndicator({ name: 'VWAP', pane: 'main' });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ extendData: stock5m }), true);
    a.addIndicator({ name: 'ATR', pane: 'sub' });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ precision: 2 }), false);
    chart().overrideIndicator.mockClear();
    a.load({ symbol: AAPL, tf: '1h', session: 'rth', pollMs: 15000 }, events());
    expect(chart().overrideIndicator).not.toHaveBeenCalled(); // same context
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
    expect(chart().overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ id: early, extendData: { ...stock5m, intraday: false } }));
    a.load({ symbol: { ...BTC, pricePrecision: 6 }, tf: '1h', session: 'rth', pollMs: 5000 }, events());
    expect(chart().overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ id: early, extendData: { assetClass: 'crypto', intraday: true, pricePrecision: 6 } }));
    expect(chart().overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ id: atrId, precision: 6 }));
  });

  it('setSessionShading creates/removes the SESSION_SHADE indicator on the candle pane', () => {
    const a = make();
    a.setSessionShading(true);
    a.setSessionShading(true);
    expect(chart().indicators.filter((i) => i.name === 'SESSION_SHADE')).toHaveLength(1);
    expect(chart().createIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: 'SESSION_SHADE', paneId: 'candle_pane' }), true);
    a.setSessionShading(false);
    expect(chart().indicators.filter((i) => i.name === 'SESSION_SHADE')).toHaveLength(0);
  });

  it('no longer shades simulated basket history (no SIMULATED_SHADE indicator, no setSimulatedShading)', () => {
    const a = make();
    expect(k.state.registered).not.toContain('SIMULATED_SHADE');
    expect((a as unknown as Record<string, unknown>)['setSimulatedShading']).toBeUndefined();
  });

  it('registers the marker overlay template (a dashed vertical line with a label, ignoring events)', () => {
    make();
    const tpl = k.state.overlayTemplates.find((t) => t.name === 'altvMarker')!;
    expect(tpl).toBeDefined();
    const figures = tpl.createPointFigures({
      overlay: { extendData: 'Start' }, coordinates: [{ x: 40, y: 99 }], bounding: { width: 300, height: 200 },
    });
    const line = figures.find((f: { type: string }) => f.type === 'line');
    expect(line.attrs.coordinates).toEqual([{ x: 40, y: 0 }, { x: 40, y: 200 }]);
    expect(line.ignoreEvent).toBe(true);
    const text = figures.find((f: { type: string }) => f.type === 'text');
    // Bottom of the candle pane (just above the x-axis), right of the line: clear of the top-left OHLC legend.
    expect(text.attrs).toMatchObject({ x: 44, y: 196, text: 'Start', baseline: 'bottom' });
    expect(text.ignoreEvent).toBe(true);
  });

  it('markers have a fixed theme style (muted, dashed) independent of the default drawing style; follow the theme', () => {
    const a = make();
    chart().data.push({ timestamp: 1000, high: 10 });
    a.setAppearance({ dark: { drawing: { color: '#ff0000', size: 4, style: 'solid' } } });
    a.setMarkers([{ ts: 1000, label: 'Start' }]);
    const marker = () => chart().overlays.find((o) => o.groupId === 'markers')!;
    expect(marker().styles).toMatchObject({ line: { color: '#868b98', style: 'dashed', size: 1 }, text: { color: '#868b98' } });
    a.setAppearance({ dark: { drawing: { color: '#00ff00', size: 2, style: 'dashed' } } });
    expect(marker().styles).toMatchObject({ line: { color: '#868b98' } });
    a.setTheme('light');
    expect(marker().styles).toMatchObject({ line: { color: '#6a6d78' }, text: { color: '#6a6d78' } });
  });

  it.each([
    ['candle', 'candle_solid'], ['ohlc', 'ohlc'], ['area', 'area'], ['line', 'area'],
  ] as const)('setChartType(%s) sets candle type %s', (t, type) => {
    const a = make();
    a.setChartType(t);
    expect(chart().setStyles).toHaveBeenLastCalledWith(expect.objectContaining({ candle: expect.objectContaining({ type }) }));
  });

  it('setChartType(line) uses a transparent area fill', () => {
    const a = make();
    a.setChartType('line');
    const styles = chart().setStyles.mock.calls.at(-1)![0];
    expect(styles.candle.area.backgroundColor).toEqual([{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0)' }]);
  });

  it('setMarkers places locked altvMarker overlays in group markers on the containing bar', () => {
    const a = make();
    chart().data.push({ timestamp: 1000, high: 10 }, { timestamp: 2000, high: 20 }, { timestamp: 3000, high: 30 });
    a.setMarkers([{ ts: 2000, label: 'v2' }, { ts: 2500, label: 'v3' }, { ts: 9999, label: 'future' }]);
    const ms = chart().overlays.filter((o) => o.groupId === 'markers');
    expect(ms.map((o) => ({ name: o.name, lock: o.lock, points: o.points, text: o.extendData }))).toEqual([
      { name: 'altvMarker', lock: true, points: [{ timestamp: 2000, value: 20 }], text: 'v2' },
      { name: 'altvMarker', lock: true, points: [{ timestamp: 3000, value: 30 }], text: 'v3' },
    ]);
    a.setMarkers([]);
    expect(chart().overlays.filter((o) => o.groupId === 'markers')).toHaveLength(0);
  });

  it('serializeDrawings excludes markers and maps name/points/lock/extendData→text', () => {
    const a = make();
    chart().data.push({ timestamp: 1000, high: 10 });
    a.setMarkers([{ ts: 1000, label: 'v1' }]);
    chart().createOverlay({ name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }] });
    chart().createOverlay({ name: 'simpleAnnotation', points: [{ timestamp: 5, value: 6 }], lock: true, extendData: 'hello' });
    expect(a.serializeDrawings()).toEqual([
      { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: false },
      { name: 'simpleAnnotation', points: [{ timestamp: 5, value: 6 }], lock: true, text: 'hello' },
    ]);
  });

  it('restoreDrawings removes existing non-marker overlays and recreates with the same points, silently', () => {
    const a = make();
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    chart().data.push({ timestamp: 1000, high: 10 });
    a.setMarkers([{ ts: 1000, label: 'v1' }]);
    chart().createOverlay({ name: 'rayLine', points: [{ timestamp: 9, value: 9 }] });
    const drawings = [
      { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: true },
      { name: 'simpleAnnotation', points: [{ timestamp: 5, value: 6 }], lock: false, text: 'note' },
    ];
    a.restoreDrawings(drawings);
    expect(a.serializeDrawings()).toEqual(drawings);
    expect(chart().overlays.filter((o) => o.groupId === 'markers')).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('fires onDrawingsChange on draw end, move end and remove; clearDrawings fires once', () => {
    const a = make();
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    a.startDrawing('segment');
    const created = chart().overlays.at(-1)!;
    expect(created.name).toBe('segment');
    created.onDrawEnd?.({ overlay: created });
    expect(changed).toHaveBeenCalledTimes(1);
    created.onPressedMoveEnd?.({ overlay: created });
    expect(changed).toHaveBeenCalledTimes(2);
    a.restoreDrawings([{ name: 'segment', points: [{ timestamp: 1, value: 1 }], lock: false }, { name: 'rayLine', points: [{ timestamp: 1, value: 1 }], lock: false }]);
    changed.mockClear();
    a.clearDrawings();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(a.serializeDrawings()).toEqual([]);
  });

  it('startDrawing passes annotation text as extendData', () => {
    const a = make();
    a.startDrawing('simpleAnnotation', { text: 'hi' });
    expect(chart().createOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'simpleAnnotation', extendData: 'hi' }));
  });

  describe('drawing tools', () => {
    const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
    const DAY = 86_400_000;

    /** Simulates KLineChart calling the installed data loader for the initial page. */
    async function fireInit(ts = [DAY, 2 * DAY]) {
      vi.spyOn(api, 'bars').mockResolvedValue({
        symbol: 'stock:AAPL', tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
        bars: ts.map((t) => ({ ts: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })),
      });
      const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
      await loader.getBars({
        type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period: { type: 'day', span: 1 },
        callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
      });
    }

    async function loaded() {
      const a = make();
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      await fireInit();
      return a;
    }

    it('removeSelected removes the last selected drawing (never markers) and fires a change', async () => {
      const a = await loaded();
      const changed = vi.fn();
      a.onDrawingsChange(changed);
      a.restoreDrawings([
        { name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false },
        { name: 'rayLine', points: [{ timestamp: 3, value: 3 }, { timestamp: 4, value: 4 }], lock: false },
      ]);
      expect(a.removeSelected()).toBe(false);
      const [first, second] = userOverlays();
      first!.onSelected?.({ overlay: first });
      second!.onSelected?.({ overlay: second });
      let atChange: string[] = [];
      changed.mockImplementation(() => { atChange = a.serializeDrawings().map((d) => d.name); });
      expect(a.removeSelected()).toBe(true);
      expect(userOverlays().map((o) => o.name)).toEqual(['segment']);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(atChange).toEqual(['segment']); // the change handler must not see the overlay being removed
      expect(a.removeSelected()).toBe(false);
      first!.onSelected?.({ overlay: first });
      first!.onDeselected?.({ overlay: first });
      expect(a.removeSelected()).toBe(false);
      expect(userOverlays()).toHaveLength(1);
    });

    it('defers restoreDrawings until the first data page of the current load arrives', async () => {
      const a = make();
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      const d = [{ name: 'segment', points: [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }], lock: false }];
      a.restoreDrawings(d);
      expect(userOverlays()).toHaveLength(0);
      await fireInit();
      expect(a.serializeDrawings()).toEqual(d);
      // A timeframe switch keeps existing drawings (anchored by timestamp) and restores immediately once data is in.
      a.restoreDrawings([]);
      expect(userOverlays()).toHaveLength(0);
      a.restoreDrawings(d);
      expect(a.serializeDrawings()).toEqual(d);
    });

    it('a pending restore is replaced by a newer one and cleared drawings are removed immediately', async () => {
      const a = make();
      a.restoreDrawings([{ name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false }]);
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      a.restoreDrawings([{ name: 'rayLine', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false }]);
      await fireInit();
      expect(userOverlays().map((o) => o.name)).toEqual(['rayLine']);
    });

    it('magnet sets the mode of new drawings', () => {
      const a = make();
      a.startDrawing('segment');
      expect(chart().createOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'segment', mode: 'normal' }));
      a.setMagnet(true);
      a.startDrawing('rayLine');
      expect(chart().createOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'rayLine', mode: 'weak_magnet' }));
    });

    it('setLockAll locks every user drawing (not markers), new ones on draw end and restored ones; fires a change', async () => {
      const a = await loaded();
      const changed = vi.fn();
      a.onDrawingsChange(changed);
      a.setMarkers([{ ts: DAY, label: 'v1' }]);
      a.restoreDrawings([{ name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false }]);
      a.setLockAll(true);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(chart().overrideOverlay).toHaveBeenCalledWith(expect.objectContaining({ lock: true }));
      expect(userOverlays().every((o) => o.lock)).toBe(true);
      a.startDrawing('rayLine');
      const created = chart().overlays.at(-1)!;
      expect(created.lock).toBe(false); // must stay interactive while it is being drawn
      created.points = [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }];
      created.onDrawEnd?.({ overlay: created });
      expect(created.lock).toBe(true);
      a.setLockAll(false);
      expect(userOverlays().every((o) => !o.lock)).toBe(true);
      expect(chart().overlays.find((o) => o.groupId === 'markers')!.lock).toBe(true);
    });

    it('startDrawing calls onEnd on draw end; cancelDrawing removes an unfinished drawing silently', () => {
      const a = make();
      const changed = vi.fn();
      a.onDrawingsChange(changed);
      const onEnd = vi.fn();
      a.startDrawing('segment', { onEnd });
      const first = chart().overlays.at(-1)!;
      first.onDrawEnd?.({ overlay: first });
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      a.startDrawing('rayLine');
      a.cancelDrawing();
      expect(userOverlays().map((o) => o.name)).toEqual(['segment']);
      expect(changed).toHaveBeenCalledTimes(1);
      a.cancelDrawing(); // nothing in progress → the finished drawing stays
      expect(userOverlays()).toHaveLength(1);
    });

    it('lock-all state is derived on restore: all locked → true; setLockAll(false) unlocks all', async () => {
      const a = await loaded();
      const lock = vi.fn();
      a.onLockAllChange(lock);
      const seg = (lockIt: boolean) => ({ name: 'segment', points: [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }], lock: lockIt });
      a.restoreDrawings([seg(true), seg(true)]);
      expect(lock).toHaveBeenLastCalledWith(true);
      a.setLockAll(false);
      expect(lock).toHaveBeenLastCalledWith(false);
      expect(userOverlays().map((o) => o.lock)).toEqual([false, false]);
      a.restoreDrawings([seg(true), seg(false)]);
      expect(lock).toHaveBeenLastCalledWith(false);
      a.restoreDrawings([seg(true)]);
      expect(lock).toHaveBeenLastCalledWith(true);
      a.restoreDrawings([]);
      expect(lock).toHaveBeenLastCalledWith(false);
    });

    it('restoring for a new symbol waits for that symbol\'s data, not the previous symbol\'s', async () => {
      const a = await loaded(); // AAPL data is in
      const d = [{ name: 'segment', points: [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }], lock: false }];
      a.restoreDrawings(d, 'crypto:BTC'); // fetched before BTC's load() started
      expect(userOverlays()).toHaveLength(0);
      a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 5000 }, events());
      await fireInit();
      expect(a.serializeDrawings()).toEqual(d);
      expect(userOverlays()).toHaveLength(1);
      a.restoreDrawings(d, 'crypto:BTC'); // same symbol, data in → immediate
      expect(userOverlays()).toHaveLength(1);
    });

    it('a failed initial page releases a pending restore', async () => {
      const a = make();
      const ev = events();
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, ev);
      const d = [{ name: 'segment', points: [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }], lock: false }];
      a.restoreDrawings(d);
      vi.spyOn(api, 'bars').mockRejectedValue(new Error('boom'));
      const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
      // The loader keeps retrying a failed init; the drawings must not wait for that.
      void loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period: { type: 'day', span: 1 }, callback: vi.fn() });
      await vi.waitFor(() => expect(ev.onConnection).toHaveBeenCalledWith(true, expect.anything()));
      expect(userOverlays()).toHaveLength(1);
      a.destroy(); // stops the retry loop
    });

    it('restoreDrawings and clearDrawings end an in-progress drawing (onEnd fires)', async () => {
      const a = await loaded();
      const onEnd = vi.fn();
      a.startDrawing('segment', { onEnd });
      a.restoreDrawings([]);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(userOverlays()).toHaveLength(0);
      const onEnd2 = vi.fn();
      a.startDrawing('rayLine', { onEnd: onEnd2 });
      a.clearDrawings();
      expect(onEnd2).toHaveBeenCalledTimes(1);
      const onEnd3 = vi.fn();
      a.startDrawing('rayLine', { onEnd: onEnd3 });
      a.cancelDrawing();
      expect(onEnd3).toHaveBeenCalledTimes(1);
    });

    it('starting a new tool cancels an unfinished drawing', () => {
      const a = make();
      a.startDrawing('segment');
      a.startDrawing('rayLine');
      expect(userOverlays().map((o) => o.name)).toEqual(['rayLine']);
    });
  });

  describe('appearance', () => {
    it('setAppearance merges the active theme\'s candle colours / body style into the theme styles', () => {
      const a = make();
      a.setAppearance({ dark: { upColor: '#00ff00', downColor: '#ff00ff', candleBody: 'hollow' }, light: { upColor: '#010203', candleBody: 'hollow' } });
      let s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ type: 'candle_stroke', bar: { upColor: '#00ff00', downWickColor: '#ff00ff' } });
      expect(s.grid).toBeDefined(); // theme styles are kept
      a.setTheme('light'); // the light theme's own settings apply live
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ type: 'candle_stroke', bar: { upColor: '#010203', downColor: '#ef5350' } });
      a.setTheme('dark');
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ bar: { upColor: '#00ff00' } });
      a.setChartType('line');
      a.setAppearance({ dark: { lineColor: '#123456', lineWidth: 4 } });
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.area).toMatchObject({ lineColor: '#123456', lineSize: 4 });
      a.setAppearance(undefined);
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.area).toMatchObject({ lineColor: '#2962ff', lineSize: 2 });
    });

    it('the reported layout: last price label text is readable; light mode falls back to defaults', () => {
      const a = make();
      a.setAppearance({ dark: { upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' } } });
      let s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.priceMark.last).toMatchObject({ upColor: '#ffffff', downColor: '#e63b7a', text: { color: '#131722' } });
      expect(s.overlay.text).toMatchObject({ backgroundColor: '#ffffff', color: '#131722' });
      a.setTheme('light');
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.priceMark.last).toMatchObject({ upColor: '#26a69a', downColor: '#ef5350' });
      expect(s.overlay.line).toMatchObject({ color: '#2962ff' });
    });
  });

  describe('indicator line widths / styles / bar colours', () => {
    it('addIndicator maps widths, dashed style and bar colours to KLineChart styles', () => {
      const a = make();
      const id = a.addIndicator({ name: 'VOL', pane: 'sub', lineWidths: [3], lineStyles: ['solid', 'dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
      const create = chart().createIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[]; bars: unknown[] } };
      expect(create.styles.lines).toEqual([
        expect.objectContaining({ color: '#d1', size: 3, style: 'solid' }),
        expect.objectContaining({ color: '#d2', size: 1, style: 'dashed', dashedValue: [4, 4] }),
      ]);
      expect(create.styles.bars).toEqual([expect.objectContaining({ style: 'fill', upColor: '#00ff00', downColor: '#ff0000', noChangeColor: '#76808F' })]);
      expect(a.listIndicators()[0]).toMatchObject({ id, lineWidths: [3], lineStyles: ['solid', 'dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
    });

    it('removing the overrides writes the defaults back explicitly (KLineChart merges styles)', () => {
      const a = make();
      const id = a.addIndicator({ name: 'MACD', pane: 'sub', lineStyles: ['dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
      a.updateIndicator(id, { calcParams: [12, 26, 9] });
      const o = chart().overrideIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[]; bars: unknown[] } };
      expect(o.styles.lines).toEqual(['#d1', '#d2', '#d3'].map((color) => expect.objectContaining({ color, size: 1, style: 'solid' })));
      expect(o.styles.bars).toEqual([expect.objectContaining({ upColor: 'rgba(45,192,142,0.7)', downColor: 'rgba(249,40,85,0.7)' })]);
      expect(a.listIndicators()[0]).not.toHaveProperty('lineStyles');
      expect(a.listIndicators()[0]).not.toHaveProperty('barColors');
    });
  });

  describe('drawing styles', () => {
    const DAY = 86_400_000;
    const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
    async function loaded() {
      const a = make();
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      vi.spyOn(api, 'bars').mockResolvedValue({
        symbol: 'stock:AAPL', tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
        bars: [DAY, 2 * DAY].map((t) => ({ ts: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })),
      });
      const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
      await loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period: { type: 'day', span: 1 }, callback: () => {} });
      return a;
    }
    const seg = { name: 'segment', points: [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }], lock: false };
    const lastStyles = () => chart().setStyles.mock.calls.at(-1)![0] as { overlay: { line: unknown; text: unknown; point: unknown } };

    it('restores normalized styles, reports the selection style and saves style changes', async () => {
      const a = await loaded();
      const changed = vi.fn();
      const selection = vi.fn();
      a.onDrawingsChange(changed);
      a.onSelectionChange(selection);
      a.restoreDrawings([{ ...seg, styles: { line: { color: '#ff0000', size: 3, style: 'dashed' } } }]);
      const o = userOverlays()[0]!;
      expect(o.styles).toEqual({ line: { color: '#ff0000', size: 3, style: 'dashed', dashedValue: [6, 4] } });
      o.onSelected?.({ overlay: o });
      expect(selection).toHaveBeenLastCalledWith({ id: o.id, kind: 'line', style: { color: '#ff0000', size: 3, style: 'dashed' }, locked: false });
      a.setSelectedStyle({ color: '#00ff00' });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, styles: { line: { color: '#00ff00', size: 3, style: 'dashed', dashedValue: [6, 4] } } });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(a.serializeDrawings()).toEqual([{ ...seg, styles: { line: { color: '#00ff00', size: 3, style: 'dashed' } } }]);
      o.onDeselected?.({ overlay: o });
      expect(selection).toHaveBeenLastCalledWith(null);
    });

    it('the default drawing style shown is exactly what the chart applies to unstyled drawings', async () => {
      const a = await loaded();
      // Theme default: overlay styles follow the theme accent (not KLineChart's own blue), from init on.
      expect((k.init.mock.calls.at(-1) as unknown as [unknown, { styles: { overlay: { line: unknown } } }])[1].styles.overlay.line)
        .toMatchObject({ color: '#2962ff', size: 1, style: 'solid' });
      a.setTheme('dark');
      expect(lastStyles().overlay.line).toMatchObject({ color: '#2962ff', size: 1, style: 'solid' });
      const drawing = { color: '#abcdef', size: 2, style: 'dashed' as const };
      a.setAppearance({ dark: { drawing }, light: { drawing } });
      expect(lastStyles().overlay.line).toMatchObject(drawing);
      expect(lastStyles().overlay.text).toMatchObject({ backgroundColor: '#abcdef', size: 12 });
      expect(lastStyles().overlay.point).toMatchObject({ color: '#abcdef' });
      a.setTheme('light'); // the light theme has the same setting here
      expect(lastStyles().overlay.line).toMatchObject(drawing);

      const selection = vi.fn();
      a.onSelectionChange(selection);
      a.restoreDrawings([seg, { name: 'simpleAnnotation', points: [{ timestamp: DAY, value: 1 }], lock: false, text: 'hi' }]);
      const [line, text] = userOverlays();
      line!.onSelected?.({ overlay: line });
      expect(selection).toHaveBeenLastCalledWith({ id: line!.id, kind: 'line', style: drawing, locked: false });
      text!.onSelected?.({ overlay: text });
      expect(selection).toHaveBeenLastCalledWith({ id: text!.id, kind: 'text', style: { color: '#abcdef', size: 12 }, locked: false });
      a.setSelectedStyle({ size: 18 });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith(expect.objectContaining({
        id: text!.id, styles: expect.objectContaining({ text: expect.objectContaining({ size: 18, backgroundColor: '#abcdef' }) }),
      }));
      expect(a.serializeDrawings()[1]!.styles).toEqual({ text: { color: '#abcdef', size: 18 } });
      line!.styles = { point: { radius: 3 } };
      expect(a.serializeDrawings()[0]).not.toHaveProperty('styles');
    });

    it('new drawings carry no styles of their own (they follow the default drawing style)', () => {
      const a = make();
      a.setAppearance({ dark: { drawing: { color: '#abcdef', size: 2, style: 'dashed' } } });
      a.startDrawing('rayLine');
      expect(chart().createOverlay.mock.calls.at(-1)![0]).not.toHaveProperty('styles');
    });

    it('a pending restore serializes legacy styles as dropped (never PUTs template styles)', () => {
      const a = make();
      a.restoreDrawings([
        { ...seg, styles: { line: { color: '#fff', size: 1 }, point: { radius: 4 } } as never },
        { ...seg, styles: { line: { color: '#ff0000', size: 2, style: 'solid' }, extra: 1 } as never },
      ]);
      const out = a.serializeDrawings();
      expect(out[0]).not.toHaveProperty('styles');
      expect(out[1]!.styles).toEqual({ line: { color: '#ff0000', size: 2, style: 'solid' } });
    });

    it('no style bar while a drawing is being placed; locked drawings are read-only; deselect closes it', async () => {
      const a = await loaded();
      const selection = vi.fn();
      a.onSelectionChange(selection);
      a.startDrawing('segment');
      const o = chart().overlays.at(-1)!;
      o.onSelected?.({ overlay: o }); // KLineChart selects the overlay as drawing starts
      expect(selection).toHaveBeenLastCalledWith(null);
      o.points = [{ timestamp: DAY, value: 1 }, { timestamp: 2 * DAY, value: 2 }];
      o.onDrawEnd?.({ overlay: o });
      expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ id: o.id, kind: 'line', locked: false }));
      a.setLockAll(true);
      expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ id: o.id, locked: true }));
      chart().overrideOverlay.mockClear();
      a.setSelectedStyle({ color: '#00ff00' });
      expect(chart().overrideOverlay).not.toHaveBeenCalled();
      a.deselect();
      expect(selection).toHaveBeenLastCalledWith(null);
      expect(a.getSelectedDrawing()).toBeNull();
    });
  });

  it('forwards a permanent init failure to onFatal (no connection-lost)', async () => {
    const { ApiError } = await import('../../src/api/client');
    const a = make();
    const ev = events();
    const onFatal = vi.fn();
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 1000 }, { ...ev, onFatal });
    vi.spyOn(api, 'bars').mockRejectedValue(new ApiError(404, 'not_found', 'Unknown symbol'));
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period: { type: 'day', span: 1 }, callback: () => {} });
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown symbol' }));
    expect(ev.onConnection).not.toHaveBeenCalled();
  });

  describe('markers follow new bars', () => {
    it('a marker after the last bar (e.g. basket Start before the open) appears once a polled bar reaches it', async () => {
      vi.useFakeTimers();
      try {
        const a = make();
        const DAY = 86_400_000;
        a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 1000 }, events());
        vi.spyOn(api, 'bars').mockResolvedValue({
          symbol: 'stock:AAPL', tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
          bars: [DAY, 2 * DAY].map((t) => ({ ts: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })),
        });
        const loader = chart().setDataLoader.mock.calls.at(-1)![0] as {
          getBars: (p: unknown) => Promise<void>; subscribeBar: (p: unknown) => void;
        };
        const period = { type: 'day', span: 1 };
        await loader.getBars({
          type: 'init', timestamp: null, symbol: { ticker: 'stock:AAPL' }, period,
          callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
        });
        a.setMarkers([{ ts: 3 * DAY, label: 'Start' }]);
        const markers = () => chart().overlays.filter((o) => o.groupId === 'markers');
        expect(markers()).toHaveLength(0); // no bar at the start yet
        vi.spyOn(api, 'latest').mockResolvedValue({ bar: { ts: 3 * DAY, open: 1, high: 3, low: 1, close: 2, volume: 1 }, stale: false });
        loader.subscribeBar({
          symbol: { ticker: 'stock:AAPL' }, period,
          callback: (d: { timestamp: number; high: number }) => { chart().data.push(d); },
        });
        await vi.advanceTimersByTimeAsync(1100);
        expect(markers()).toHaveLength(1);
        expect(markers()[0]).toMatchObject({ extendData: 'Start', points: [{ timestamp: 3 * DAY, value: 3 }] });
        const created = chart().createOverlay.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1100); // same bar again: no re-render churn
        expect(chart().createOverlay.mock.calls.length).toBe(created);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('strong magnet override (⌘ / Ctrl held)', () => {
    it('switches the in-progress drawing to strong_magnet and back to the toolbar mode', () => {
      const a = make();
      a.setMagnet(true);
      a.startDrawing('segment');
      const o = chart().overlays.at(-1)!;
      a.setMagnetOverride(true);
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, mode: 'strong_magnet' });
      a.setMagnetOverride(false);
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, mode: 'weak_magnet' });
      a.setMagnet(false);
      a.setMagnetOverride(true);
      a.startDrawing('rayLine'); // started while held
      expect(chart().createOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'rayLine', mode: 'strong_magnet' }));
      const r = chart().overlays.at(-1)!;
      r.onDrawEnd?.({ overlay: r });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: r.id, mode: 'normal' }); // finished: back to toolbar mode
    });

    it('applies to a drawing being dragged and reverts on drag end', () => {
      const a = make();
      a.restoreDrawings([]);
      a.startDrawing('segment');
      const o = chart().overlays.at(-1)!;
      o.onDrawEnd?.({ overlay: o });
      chart().overrideOverlay.mockClear();
      a.setMagnetOverride(true);
      expect(chart().overrideOverlay).not.toHaveBeenCalled(); // nothing active
      (o as unknown as { onPressedMoveStart: (e: unknown) => void }).onPressedMoveStart({ overlay: o });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, mode: 'strong_magnet' });
      o.onPressedMoveEnd?.({ overlay: o });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, mode: 'normal' });
      chart().overrideOverlay.mockClear();
      a.setMagnetOverride(false);
      expect(chart().overrideOverlay).not.toHaveBeenCalled();
    });
  });

  it('setTheme re-applies styles; resize and destroy delegate', () => {
    const a = make();
    a.setTheme('light');
    expect(chart().setStyles).toHaveBeenCalled();
    a.resize();
    expect(chart().resize).toHaveBeenCalled();
    a.destroy();
    expect(k.dispose).toHaveBeenCalledWith(el);
  });
});

describe('ChartAdapter quick second click while drawing (KLineChart 500 ms double-click window)', () => {
  const press = (x: number, y = 10) => el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }));
  function withClickState() {
    const reset = vi.fn();
    (chart() as unknown as Record<string, unknown>)['_chartEvent'] = { _event: { _resetClickTimeout: reset } };
    return reset;
  }

  it('while a drawing is placed, a press away from the previous one starts a fresh click sequence', () => {
    vi.useFakeTimers();
    try {
      const a = make();
      const reset = withClickState();
      a.startDrawing('segment');
      press(100);
      vi.advanceTimersByTime(200);
      press(300); // far from the first press → would be swallowed as a "double-click"
      expect(reset).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deliberate double-click (same spot, < 500 ms) is left to KLineChart; nothing happens when not drawing', () => {
    vi.useFakeTimers();
    try {
      const a = make();
      const reset = withClickState();
      press(100);
      press(300);
      expect(reset).not.toHaveBeenCalled(); // not drawing
      a.startDrawing('segment');
      press(100);
      vi.advanceTimersByTime(150);
      reset.mockClear();
      press(102); // 2 px away within 500 ms: a double-click
      expect(reset).not.toHaveBeenCalled();
      a.cancelDrawing();
      press(400);
      expect(reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op when the KLineChart internals are not there', () => {
    const a = make();
    a.startDrawing('segment');
    expect(() => { press(1); press(200); }).not.toThrow();
  });
});

describe('ChartAdapter daily-anchored drawings (anchorTf)', () => {
  const D1 = Date.UTC(2024, 2, 4); // Mon 2024-03-04 (EST)
  const D2 = Date.UTC(2024, 6, 8); // Mon 2024-07-08 (EDT)
  const OPEN1 = Date.UTC(2024, 2, 4, 14, 30); // 09:30 New York
  const OPEN2 = Date.UTC(2024, 6, 8, 13, 30);
  const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
  const BASKET: SymbolInfo = { id: 'basket:b1', assetClass: 'basket', ticker: 'B1', name: 'B1', pricePrecision: 2 };
  const anchored = { name: 'segment', points: [{ timestamp: D1, value: 10 }, { timestamp: D2, value: 20 }], lock: false, anchorTf: '1D' as const };

  async function loadAt(a: InstanceType<typeof ChartAdapter>, symbol: SymbolInfo, tf: '1D' | '1W' | '1h' | '5m', extra: { basketHasCrypto?: boolean } = {}) {
    a.load({ symbol, tf, session: 'rth', pollMs: 15000, ...extra }, events());
    vi.spyOn(api, 'bars').mockResolvedValue({
      symbol: symbol.id, tf, session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
      bars: [{ ts: D1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    });
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({
      type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
    });
  }

  /** Simulates the user placing a trend line with KLineChart. */
  function draw(a: InstanceType<typeof ChartAdapter>, points: Array<{ timestamp: number; value: number }>) {
    a.startDrawing('segment');
    const o = userOverlays().at(-1)!;
    o.points = points;
    o.onDrawEnd?.({ overlay: o });
  }

  function move(points: Array<{ timestamp: number; value: number }>) {
    const o = userOverlays()[0]!;
    (o as FakeOverlay & { onPressedMoveStart?: (e: unknown) => void }).onPressedMoveStart?.({ overlay: o });
    o.points = points;
    o.onPressedMoveEnd?.({ overlay: o });
  }

  /** A plain click on a drawing: KLineChart fires onPressedMoveStart/End even without any movement. */
  function pressWithoutMove() {
    const o = userOverlays()[0]!;
    (o as FakeOverlay & { onPressedMoveStart?: (e: unknown) => void }).onPressedMoveStart?.({ overlay: o });
    o.points = o.points.map((p) => ({ ...p })); // same values, new objects
    o.onPressedMoveEnd?.({ overlay: o });
  }

  it('a press without movement keeps a daily-anchored drawing as stored (intraday and daily charts)', async () => {
    for (const tf of ['5m', '1D', '1W'] as const) {
      const a = make();
      await loadAt(a, AAPL, tf);
      a.restoreDrawings([anchored], AAPL.id);
      pressWithoutMove();
      expect(a.serializeDrawings(), tf).toEqual([anchored]);
    }
  });

  it('a press without movement on a daily chart never anchors an intraday drawing', async () => {
    const intraday = { name: 'segment', points: [{ timestamp: OPEN1 + 60_000, value: 1 }, { timestamp: OPEN2, value: 2 }], lock: false };
    const a = make();
    await loadAt(a, AAPL, '1D');
    a.restoreDrawings([intraday], AAPL.id);
    pressWithoutMove();
    expect(a.serializeDrawings()).toEqual([intraday]);
  });

  it('a real move on a daily chart anchors a previously intraday drawing', async () => {
    const a = make();
    await loadAt(a, AAPL, '1D');
    a.restoreDrawings([{ name: 'segment', points: [{ timestamp: OPEN1, value: 1 }, { timestamp: OPEN2, value: 2 }], lock: false }], AAPL.id);
    move([{ timestamp: D1, value: 3 }, { timestamp: D2, value: 4 }]);
    expect(a.serializeDrawings()[0]).toMatchObject({ anchorTf: '1D', points: [{ timestamp: D1, value: 3 }, { timestamp: D2, value: 4 }] });
  });

  it('baskets containing crypto use the UTC grid: anchored drawings are not remapped on intraday', async () => {
    const a = make();
    await loadAt(a, BASKET, '1h', { basketHasCrypto: true });
    a.restoreDrawings([anchored], BASKET.id);
    expect(userOverlays()[0]!.points).toEqual(anchored.points);
    expect(a.serializeDrawings()).toEqual([anchored]);
  });

  it('a drawing created on a daily+ timeframe of a stock/basket stores anchorTf; intraday and crypto ones do not', async () => {
    for (const [symbol, tf, expected] of [
      [AAPL, '1D', '1D'], [BASKET, '1W', '1W'], [AAPL, '1h', undefined], [BTC, '1D', undefined],
    ] as const) {
      const a = make();
      await loadAt(a, symbol, tf);
      draw(a, [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }]);
      expect(a.serializeDrawings()[0]?.anchorTf, `${symbol.id} ${tf}`).toBe(expected);
    }
  });

  it('on an intraday stock/basket chart a daily-anchored drawing shows at 09:30 New York of its dates; saved unchanged', async () => {
    for (const symbol of [AAPL, BASKET]) {
      const a = make();
      await loadAt(a, symbol, '1h');
      a.restoreDrawings([anchored], symbol.id);
      expect(userOverlays()[0]!.points).toEqual([{ timestamp: OPEN1, value: 10 }, { timestamp: OPEN2, value: 20 }]);
      expect(a.serializeDrawings()).toEqual([anchored]);
    }
  });

  it('crypto and daily charts show anchored drawings as stored', async () => {
    for (const [symbol, tf] of [[BTC, '1h'], [AAPL, '1D']] as const) {
      const a = make();
      await loadAt(a, symbol, tf);
      a.restoreDrawings([anchored], symbol.id);
      expect(userOverlays()[0]!.points).toEqual(anchored.points);
      expect(a.serializeDrawings()).toEqual([anchored]);
    }
  });

  it('moving an anchored drawing on an intraday chart stores the new (intraday) points and drops anchorTf', async () => {
    const a = make();
    await loadAt(a, AAPL, '5m');
    a.restoreDrawings([anchored], AAPL.id);
    const moved = [{ timestamp: OPEN1 + 3_600_000, value: 11 }, { timestamp: OPEN2, value: 20 }];
    move(moved);
    expect(a.serializeDrawings()).toEqual([{ name: 'segment', points: moved, lock: false }]);
  });

  it('moving on a daily+ chart keeps daily semantics with that timeframe as anchor', async () => {
    const a = make();
    await loadAt(a, AAPL, '1W');
    a.restoreDrawings([anchored], AAPL.id);
    move([{ timestamp: D2, value: 5 }, { timestamp: D2, value: 6 }]);
    expect(a.serializeDrawings()[0]).toMatchObject({ anchorTf: '1W', points: [{ timestamp: D2, value: 5 }, { timestamp: D2, value: 6 }] });
  });

  it('switching the same symbol between daily and intraday re-places anchored drawings', async () => {
    const a = make();
    await loadAt(a, AAPL, '1D');
    a.restoreDrawings([anchored, { name: 'segment', points: [{ timestamp: 5, value: 1 }, { timestamp: 6, value: 2 }], lock: false }], AAPL.id);
    await loadAt(a, AAPL, '1h');
    expect(userOverlays().map((o) => o.points)).toEqual([
      [{ timestamp: OPEN1, value: 10 }, { timestamp: OPEN2, value: 20 }],
      [{ timestamp: 5, value: 1 }, { timestamp: 6, value: 2 }],
    ]);
    await loadAt(a, AAPL, '1D');
    expect(userOverlays()[0]!.points).toEqual(anchored.points);
    expect(a.serializeDrawings()[0]).toEqual(anchored);
  });
});

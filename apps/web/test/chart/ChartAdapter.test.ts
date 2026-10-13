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
      setStyles: vi.fn(), setFormatter: vi.fn(), overrideXAxis: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), setTimezone: vi.fn(), resetData: vi.fn(),
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
const { softTone } = await import('../../src/chart/color');
const { THEME_TOKENS } = await import('../../src/chart/theme');

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
const MA_DARK = ['#f2b861', '#a99bff', '#3fc8e4', '#ff8f5a'];
const MA_LIGHT = ['#c98512', '#5b49e0', '#0a8ea6', '#e0621a'];
type LineStyles = { styles?: { lines?: Array<{ color: string; size: number }> } };
const lineColors = (c: unknown) => (c as LineStyles).styles?.lines?.map((l) => l.color);

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

  it('updateIndicator without lineColors resets a previous color override to the default line colors', () => {
    const a = make();
    const id = a.addIndicator({ name: 'MA', pane: 'main', calcParams: [20], lineColors: ['#fff'] });
    a.updateIndicator(id, { calcParams: [30] });
    expect(chart().overrideIndicator).toHaveBeenLastCalledWith(expect.objectContaining({
      id, calcParams: [30], styles: { lines: MA_DARK.map((color) => expect.objectContaining({ color, size: 1, style: 'solid' })) },
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

  it('axis / legend precision: price-unit oscillators (MACD, AO, MTM) take the price precision, bounded ones (RSI …) 2', () => {
    const a = make();
    const macd = a.addIndicator({ name: 'MACD', pane: 'sub' });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'MACD', precision: 4 }), false);
    a.addIndicator({ name: 'RSI', pane: 'sub' });
    expect(chart().createIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'RSI', precision: 2 }), false);
    a.addIndicator({ name: 'VOL', pane: 'sub' });
    expect(chart().createIndicator.mock.calls.at(-1)![0]).not.toHaveProperty('precision');
    a.load({ symbol: AAPL, tf: '1h', session: 'rth', pollMs: 15000 }, events());
    expect(chart().overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ id: macd, precision: 2 }));
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
    const tpl = k.state.overlayTemplates.find((t) => t.name === 'chartmateMarker')!;
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
    expect(marker().styles).toMatchObject({ line: { color: '#8f97ab', style: 'dashed', size: 1 }, text: { color: '#8f97ab' } });
    a.setAppearance({ dark: { drawing: { color: '#00ff00', size: 2, style: 'dashed' } } });
    expect(marker().styles).toMatchObject({ line: { color: '#8f97ab' } });
    a.setTheme('light');
    expect(marker().styles).toMatchObject({ line: { color: '#545c6f' }, text: { color: '#545c6f' } });
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

  it('setMarkers places locked chartmateMarker overlays in group markers on the containing bar', () => {
    const a = make();
    chart().data.push({ timestamp: 1000, high: 10 }, { timestamp: 2000, high: 20 }, { timestamp: 3000, high: 30 });
    a.setMarkers([{ ts: 2000, label: 'v2' }, { ts: 2500, label: 'v3' }, { ts: 9999, label: 'future' }]);
    const ms = chart().overlays.filter((o) => o.groupId === 'markers');
    expect(ms.map((o) => ({ name: o.name, lock: o.lock, points: o.points, text: o.extendData }))).toEqual([
      { name: 'chartmateMarker', lock: true, points: [{ timestamp: 2000, value: 20 }], text: 'v2' },
      { name: 'chartmateMarker', lock: true, points: [{ timestamp: 3000, value: 30 }], text: 'v3' },
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
    it('time texts follow the timeframe: axis ticks with context, crosshair date, and a countdown capsule for intraday bars', () => {
      const a = make();
      a.load({ symbol: AAPL, tf: '1h', session: 'rth', pollMs: 15000 }, events());
      const fmt = chart().setFormatter.mock.calls.at(-1)![0] as { formatDate: (p: { timestamp: number }) => string; formatExtendText: (p: { data: { timestamp: number } }) => string };
      expect(fmt.formatDate({ timestamp: Date.parse('2026-09-30T16:30:00Z') })).toBe("Wed Sep 30 '26 · 12:30");
      // A stock's 1h bar from 15:30 New York closes with the session at 16:00 (Oct: UTC-4).
      const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T19:45:00Z'));
      expect(fmt.formatExtendText({ data: { timestamp: Date.parse('2026-10-13T19:30:00Z') } })).toBe('15:00');
      spy.mockRestore();
      const x = chart().overrideXAxis.mock.calls.at(-1)![0] as { createTicks: (p: { defaultTicks: Array<{ coord: number; value: number; text: string }> }) => Array<{ text: string }> };
      const ticks = x.createTicks({ defaultTicks: [Date.parse('2026-09-29T14:00:00Z'), Date.parse('2026-09-30T14:00:00Z')].map((value, i) => ({ coord: i * 50, value, text: '' })) });
      expect(ticks.map((t) => t.text)).toEqual(['Sep 29', '30']);
      expect(chart().setStyles.mock.calls.at(-1)![0].candle.priceMark.last.extendTexts[0].show).toBe(true);
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      expect(chart().setStyles.mock.calls.at(-1)![0].candle.priceMark.last.extendTexts[0].show).toBe(false);
      a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 15000 }, events());
      expect(chart().setStyles.mock.calls.at(-1)![0].candle.priceMark.last.extendTexts[0].show).toBe(true);
    });

    it('setAppearance merges the active theme\'s candle colors / body style into the theme styles', () => {
      const a = make();
      a.setAppearance({ dark: { upColor: '#00ff00', downColor: '#ff00ff', candleBody: 'hollow' }, light: { upColor: '#010203', candleBody: 'hollow' } });
      let s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ type: 'candle_stroke', bar: { upColor: '#00ff00', downWickColor: '#ff00ff' } });
      expect(s.grid).toBeDefined(); // theme styles are kept
      a.setTheme('light'); // the light theme's own settings apply live
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ type: 'candle_stroke', bar: { upColor: '#010203', downColor: '#d92855' } }); // light default down
      a.setTheme('dark');
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle).toMatchObject({ bar: { upColor: '#00ff00' } });
      a.setChartType('line');
      a.setAppearance({ dark: { lineColor: '#123456', lineWidth: 4 } });
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.area).toMatchObject({ lineColor: '#123456', lineSize: 4 });
      a.setAppearance(undefined);
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.area).toMatchObject({ lineColor: THEME_TOKENS.dark.accent, lineSize: 2 });
    });

    it('default indicator bars follow the theme up / down colors, opaque (the exact candle colors)', () => {
      const a = make();
      expect(chart().setStyles).not.toHaveBeenCalled();
      a.setTheme('light');
      expect(chart().setStyles.mock.calls.at(-1)![0].indicator.bars).toEqual([
        { style: 'fill', borderSize: 0, upColor: '#12b996', downColor: '#d92855', noChangeColor: '#545c6f' },
      ]);
      a.setTheme('dark');
      expect(chart().setStyles.mock.calls.at(-1)![0].indicator.bars).toEqual([
        { style: 'fill', borderSize: 0, upColor: '#34e0b8', downColor: '#ff4d73', noChangeColor: '#8f97ab' },
      ]);
    });

    it('default indicator bars follow the custom candle colors of the active theme (chart styles and reset indicators)', () => {
      const a = make();
      const reset = a.addIndicator({ name: 'VOL', pane: 'sub', barColors: { up: '#00ff00', down: '#ff0000' } });
      const custom = a.addIndicator({ name: 'MACD', pane: 'sub', barColors: { up: '#0000ff', down: '#ffff00' } });
      a.updateIndicator(reset, { calcParams: [5, 10, 20] }); // override removed → defaults written explicitly
      chart().overrideIndicator.mockClear();
      a.setAppearance({ dark: { upColor: '#3366ff', downColor: '#ffaa00' } });
      expect(chart().setStyles.mock.calls.at(-1)![0].indicator.bars).toEqual([
        { style: 'fill', borderSize: 0, upColor: '#3366ff', downColor: '#ffaa00', noChangeColor: '#8f97ab' },
      ]);
      const calls = chart().overrideIndicator.mock.calls.map((c) => c[0] as { id: string; styles?: { bars?: unknown[] } });
      expect(calls.filter((c) => c.id === reset && c.styles?.bars)).toEqual([
        expect.objectContaining({ styles: { bars: [expect.objectContaining({ upColor: '#3366ff', downColor: '#ffaa00' })] } }),
      ]);
      expect(calls.filter((c) => c.id === custom && c.styles?.bars)).toEqual([]);
      // Removing an override later writes the candle colors back, not the theme's.
      a.updateIndicator(custom, {});
      const o = chart().overrideIndicator.mock.calls.at(-1)![0] as { styles: { bars: unknown[] } };
      expect(o.styles.bars).toEqual([expect.objectContaining({ upColor: '#3366ff', downColor: '#ffaa00' })]);
      // The light theme has no custom colors: its own defaults.
      a.setTheme('light');
      expect(chart().setStyles.mock.calls.at(-1)![0].indicator.bars).toEqual([
        expect.objectContaining({ upColor: THEME_TOKENS.light.up, downColor: THEME_TOKENS.light.down }),
      ]);
    });

    it('the reported layout: last price label text is readable; light mode falls back to defaults', () => {
      const a = make();
      a.setAppearance({ dark: { upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' } } });
      let s = chart().setStyles.mock.calls.at(-1)![0];
      // Neutral last price line by default: the theme's lamp white with dark text on the dark theme.
      expect(s.candle.priceMark.last).toMatchObject({ upColor: '#e9ecf4', downColor: '#e9ecf4', noChangeColor: '#e9ecf4', text: { color: '#131722' } });
      expect(s.overlay.text).toMatchObject({ backgroundColor: '#ffffff', color: '#131722' });
      a.setTheme('light');
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.priceMark.last).toMatchObject({ upColor: '#131726', downColor: '#131726', text: { color: '#ffffff' } });
      expect(s.candle.bar).toMatchObject({ upColor: '#12b996', downColor: '#d92855' });
      a.setAppearance({ light: { lastPriceLine: 'candle' } });
      s = chart().setStyles.mock.calls.at(-1)![0];
      expect(s.candle.priceMark.last).toMatchObject({ upColor: '#12b996', downColor: '#d92855', text: { color: '#131722' } });
      expect(s.overlay.line).toMatchObject({ color: THEME_TOKENS.light.accent });
    });
  });

  describe('indicator default line colors follow the theme palette', () => {
    it('new indicators get the active theme palette by slot (BOLL upper/middle/lower = slots 2/1/3, VWAP = slot 3)', () => {
      const a = make();
      a.addIndicator({ name: 'MA', pane: 'main' });
      expect(lineColors(chart().createIndicator.mock.calls.at(-1)![0])).toEqual(MA_DARK);
      a.addIndicator({ name: 'BOLL', pane: 'main' });
      expect(lineColors(chart().createIndicator.mock.calls.at(-1)![0])).toEqual(['#a99bff', '#f2b861', '#3fc8e4']);
      a.addIndicator({ name: 'VWAP', pane: 'main' });
      expect(lineColors(chart().createIndicator.mock.calls.at(-1)![0])).toEqual(['#3fc8e4']);
      const light = new ChartAdapter(el, { theme: 'light' });
      light.addIndicator({ name: 'MA', pane: 'main' });
      expect(lineColors(chart().createIndicator.mock.calls.at(-1)![0])).toEqual(MA_LIGHT);
    });

    it('a theme toggle re-applies the palette to indicators without user colors (also with only width overrides); user colors stay exactly', () => {
      const a = make();
      const plain = a.addIndicator({ name: 'MA', pane: 'main' });
      const wide = a.addIndicator({ name: 'EMA', pane: 'main', lineWidths: [3] });
      const user = a.addIndicator({ name: 'RSI', pane: 'sub', lineColors: ['#111111', '#222222', '#333333'] });
      chart().overrideIndicator.mockClear();
      a.setTheme('light');
      const calls = chart().overrideIndicator.mock.calls.map((c) => c[0] as { id: string } & LineStyles);
      expect(lineColors(calls.find((c) => c.id === plain))).toEqual(MA_LIGHT);
      const w = calls.find((c) => c.id === wide)!;
      expect(lineColors(w)).toEqual(MA_LIGHT.slice(0, 3));
      expect(w.styles!.lines![0]!.size).toBe(3); // width override survives
      expect(calls.find((c) => c.id === user)).toBeUndefined();
      expect(a.listIndicators().find((i) => i.id === user)!.lineColors).toEqual(['#111111', '#222222', '#333333']);
      chart().overrideIndicator.mockClear();
      a.setTheme('dark');
      expect(lineColors(chart().overrideIndicator.mock.calls.map((c) => c[0] as { id: string } & LineStyles).find((c) => c.id === plain))).toEqual(MA_DARK);
    });

    it('removing a user color override (Reset) writes the current theme palette', () => {
      const a = make();
      a.setTheme('light');
      const id = a.addIndicator({ name: 'MA', pane: 'main', lineColors: ['#fff'] });
      a.updateIndicator(id, {});
      expect(lineColors(chart().overrideIndicator.mock.calls.at(-1)![0])).toEqual(MA_LIGHT);
    });

    it('MACD lines use slots 1-2', () => {
      const a = make();
      a.addIndicator({ name: 'MACD', pane: 'sub' });
      expect(lineColors(chart().createIndicator.mock.calls.at(-1)![0])).toEqual(['#f2b861', '#a99bff']);
    });
  });

  describe('indicator line widths / styles / bar colors', () => {
    it('histogram bars are always filled: a template bar drawn as an outline (MACD / AO rising) is filled in the opaque soft tone of the active theme', () => {
      const a = make();
      const create = chart().createIndicator.getMockImplementation()!;
      chart().createIndicator.mockImplementationOnce((v, stack) => {
        const id = create(v, stack);
        const figures = [{ key: 'dif', type: 'line' }, { key: 'macd', type: 'bar', styles: () => ({ style: 'stroke', color: '#00ff00' }) }];
        Object.assign(chart().indicators.find((i) => i.id === id)!, { figures });
        return id;
      });
      const id = a.addIndicator({ name: 'MACD', pane: 'sub' });
      const o = chart().overrideIndicator.mock.calls.at(-1)![0] as { id: string; name: string; figures: Array<{ key: string; styles?: (p: unknown) => unknown }> };
      expect(o).toMatchObject({ id, name: 'MACD' });
      expect(o.figures.map((f) => f.key)).toEqual(['dif', 'macd']);
      const darkSoft = softTone('#00ff00', THEME_TOKENS.dark.bg);
      expect(darkSoft).toMatch(/^#[0-9a-f]{6}$/);
      expect(o.figures[1]!.styles!({})).toEqual({ style: 'fill', color: darkSoft, borderColor: darkSoft });
      // Resolved at draw time: after a theme toggle the same figure takes the light theme's soft tone.
      a.setTheme('light');
      const lightSoft = softTone('#00ff00', THEME_TOKENS.light.bg);
      expect(o.figures[1]!.styles!({})).toEqual({ style: 'fill', color: lightSoft, borderColor: lightSoft });
      a.setTheme('dark');
      // Without stroke bars (e.g. VOL, whose bars follow the chart's fill style) nothing is overridden.
      chart().overrideIndicator.mockClear();
      a.addIndicator({ name: 'VOL', pane: 'sub' });
      expect(chart().overrideIndicator).not.toHaveBeenCalled();
    });

    it('addIndicator maps widths, dashed style and bar colors to KLineChart styles', () => {
      const a = make();
      const id = a.addIndicator({ name: 'VOL', pane: 'sub', lineWidths: [3], lineStyles: ['solid', 'dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
      const create = chart().createIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[]; bars: unknown[] } };
      expect(create.styles.lines).toEqual([
        expect.objectContaining({ color: '#f2b861', size: 3, style: 'solid' }),
        expect.objectContaining({ color: '#a99bff', size: 1, style: 'dashed', dashedValue: [4, 4] }),
        expect.objectContaining({ color: '#3fc8e4', size: 1, style: 'solid' }),
      ]);
      expect(create.styles.bars).toEqual([expect.objectContaining({ style: 'fill', upColor: '#00ff00', downColor: '#ff0000', noChangeColor: '#76808F' })]);
      expect(a.listIndicators()[0]).toMatchObject({ id, lineWidths: [3], lineStyles: ['solid', 'dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
    });

    it('a partial override array still gives every catalog line the theme palette on create', () => {
      const a = make();
      a.addIndicator({ name: 'EMA', pane: 'main', lineWidths: [3] });
      const create = chart().createIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[] } };
      expect(create.styles.lines).toEqual([
        expect.objectContaining({ color: '#f2b861', size: 3 }),
        expect.objectContaining({ color: '#a99bff', size: 1 }),
        expect.objectContaining({ color: '#3fc8e4', size: 1 }),
      ]);
    });

    it('dotted indicator lines are dashed with a dot pattern scaled by the width (1px square dots, round caps from 2px); dotted→solid resets the cap', () => {
      const a = make();
      const id = a.addIndicator({ name: 'RSI', pane: 'sub', lineWidths: [1, 3], lineStyles: ['dotted', 'dotted'] });
      const create = chart().createIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[] } };
      expect(create.styles.lines).toEqual([
        expect.objectContaining({ size: 1, style: 'dashed', dashedValue: [1, 2], lineCap: 'butt' }),
        expect.objectContaining({ size: 3, style: 'dashed', dashedValue: [0, 6], lineCap: 'round' }),
        expect.objectContaining({ size: 1, style: 'solid', lineCap: 'butt' }), // RSI's 3rd line: not overridden
      ]);
      expect(a.listIndicators()[0]).toMatchObject({ lineStyles: ['dotted', 'dotted'] });
      a.updateIndicator(id, { lineStyles: ['solid', 'dashed'] });
      const o = chart().overrideIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[] } };
      expect(o.styles.lines).toEqual([
        expect.objectContaining({ style: 'solid', lineCap: 'butt' }),
        expect.objectContaining({ style: 'dashed', dashedValue: [4, 4], lineCap: 'butt' }),
      ]);
    });

    it('a theme toggle gives reset (non-overridden) indicators the new theme\'s default bars live; overrides stay', () => {
      const a = make();
      const reset = a.addIndicator({ name: 'VOL', pane: 'sub', barColors: { up: '#00ff00', down: '#ff0000' } });
      const custom = a.addIndicator({ name: 'MACD', pane: 'sub', barColors: { up: '#0000ff', down: '#ffff00' } });
      a.updateIndicator(reset, { calcParams: [5, 10, 20] }); // override removed → dark defaults written explicitly
      chart().overrideIndicator.mockClear();
      a.setTheme('light');
      const calls = chart().overrideIndicator.mock.calls.map((c) => c[0] as { id: string; styles?: { bars?: unknown[] } });
      expect(calls.filter((c) => c.id === reset && c.styles?.bars)).toEqual([
        expect.objectContaining({ styles: { bars: [expect.objectContaining({ style: 'fill', upColor: '#12b996', downColor: '#d92855' })] } }),
      ]);
      expect(calls.filter((c) => c.id === custom && c.styles?.bars)).toEqual([]); // the user's bar colors win
      expect(a.listIndicators().find((i) => i.id === reset)).not.toHaveProperty('barColors');
      // Setting an override again stops the theme updates for that indicator; removing it stops them for good.
      a.updateIndicator(reset, { barColors: { up: '#123456', down: '#654321' } });
      chart().overrideIndicator.mockClear();
      a.setTheme('dark');
      const barCalls = (id?: string) => chart().overrideIndicator.mock.calls.map((c) => c[0] as { id: string; styles?: { bars?: unknown[] } }).filter((c) => c.styles?.bars && (!id || c.id === id));
      expect(barCalls(reset)).toEqual([]);
      a.updateIndicator(reset, {});
      a.removeIndicator(reset);
      chart().overrideIndicator.mockClear();
      a.setTheme('light');
      expect(barCalls(reset)).toEqual([]);
    });

    it('removing the overrides writes the defaults back explicitly (KLineChart merges styles)', () => {
      const a = make();
      const id = a.addIndicator({ name: 'MACD', pane: 'sub', lineStyles: ['dashed'], barColors: { up: '#00ff00', down: '#ff0000' } });
      a.updateIndicator(id, { calcParams: [12, 26, 9] });
      const o = chart().overrideIndicator.mock.calls.at(-1)![0] as { styles: { lines: unknown[]; bars: unknown[] } };
      expect(o.styles.lines).toEqual(['#f2b861', '#a99bff'].map((color) => expect.objectContaining({ color, size: 1, style: 'solid' })));
      // The theme's default bars (dark), not KLineChart's own green / red.
      expect(o.styles.bars).toEqual([expect.objectContaining({ style: 'fill', upColor: '#34e0b8', downColor: '#ff4d73' })]);
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
      expect(o.styles).toEqual({ line: { color: '#ff0000', size: 3, style: 'dashed', dashedValue: [6, 4], lineCap: 'butt' } });
      o.onSelected?.({ overlay: o });
      expect(selection).toHaveBeenLastCalledWith({ id: o.id, kind: 'line', style: { color: '#ff0000', size: 3, style: 'dashed' }, locked: false });
      a.setSelectedStyle({ color: '#00ff00' });
      expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: o.id, styles: { line: { color: '#00ff00', size: 3, style: 'dashed', dashedValue: [6, 4], lineCap: 'butt' } } });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(a.serializeDrawings()).toEqual([{ ...seg, styles: { line: { color: '#00ff00', size: 3, style: 'dashed' } } }]);
      o.onDeselected?.({ overlay: o });
      expect(selection).toHaveBeenLastCalledWith(null);
    });

    it('a dotted drawing round-trips: restored as a round-cap dot pattern, saved as dotted, scales with width', async () => {
      const a = await loaded();
      a.restoreDrawings([{ ...seg, styles: { line: { color: '#ff0000', size: 2, style: 'dotted' } } }]);
      const o = userOverlays()[0]!;
      expect(o.styles).toEqual({ line: { color: '#ff0000', size: 2, style: 'dashed', dashedValue: [0, 4], lineCap: 'round' } });
      expect(a.serializeDrawings()[0]!.styles).toEqual({ line: { color: '#ff0000', size: 2, style: 'dotted' } });
      o.onSelected?.({ overlay: o });
      expect(a.getSelectedDrawing()).toMatchObject({ style: { style: 'dotted', size: 2 } });
      a.setSelectedStyle({ size: 4 });
      expect(o.styles).toMatchObject({ line: { dashedValue: [0, 8], lineCap: 'round' } });
      a.setSelectedStyle({ style: 'solid' });
      expect(o.styles).toMatchObject({ line: { style: 'solid', lineCap: 'butt' } });
      expect(a.serializeDrawings()[0]!.styles).toEqual({ line: { color: '#ff0000', size: 4, style: 'solid' } });
    });

    it('the default drawing style shown is exactly what the chart applies to unstyled drawings', async () => {
      const a = await loaded();
      // Theme default: overlay styles follow the theme accent (not KLineChart's own blue), from init on.
      expect((k.init.mock.calls.at(-1) as unknown as [unknown, { styles: { overlay: { line: unknown } } }])[1].styles.overlay.line)
        .toMatchObject({ color: THEME_TOKENS.dark.accent, size: 1, style: 'solid' });
      a.setTheme('dark');
      expect(lastStyles().overlay.line).toMatchObject({ color: THEME_TOKENS.dark.accent, size: 1, style: 'solid' });
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

describe('ChartAdapter precise price of horizontal drawings', () => {
  const D1 = Date.UTC(2024, 2, 4);
  const D2 = Date.UTC(2024, 6, 8);
  const OPEN1 = Date.UTC(2024, 2, 4, 14, 30); // 09:30 New York
  const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
  const ETH: SymbolInfo = { id: 'crypto:ETH', assetClass: 'crypto', ticker: 'ETH', name: 'Ether', pricePrecision: 3 };

  async function loadAt(symbol: SymbolInfo, tf: '1D' | '1h') {
    const a = make();
    a.load({ symbol, tf, session: 'rth', pollMs: 15000 }, events());
    vi.spyOn(api, 'bars').mockResolvedValue({
      symbol: symbol.id, tf, session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
      bars: [{ ts: D1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    });
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({
      type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: { type: 'day', span: 1 },
      callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
    });
    return a;
  }
  const select = (o: FakeOverlay) => o.onSelected?.({ overlay: o });

  it('getSelectedDrawing exposes the price and symbol precision of horizontal kinds only', async () => {
    const a = await loadAt(ETH, '1h');
    a.restoreDrawings([
      { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 1234.5 }], lock: false },
      { name: 'priceLine', points: [{ timestamp: D1, value: 99.125 }], lock: true },
      { name: 'horizontalRayLine', points: [{ timestamp: D1, value: 7 }, { timestamp: D2, value: 7 }], lock: false },
      { name: 'segment', points: [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }], lock: false },
    ]);
    const [h, p, r, s] = userOverlays();
    select(h!);
    expect(a.getSelectedDrawing()).toMatchObject({ kind: 'line', price: { value: 1234.5, precision: 3 } });
    select(p!);
    expect(a.getSelectedDrawing()).toMatchObject({ price: { value: 99.125, precision: 3 }, locked: true });
    select(r!);
    expect(a.getSelectedDrawing()).toMatchObject({ price: { value: 7, precision: 3 } });
    select(s!);
    expect(a.getSelectedDrawing()).not.toHaveProperty('price');
  });

  it('setSelectedPrice moves every point to the price via overrideOverlay keeping the timestamps; saved and emitted', async () => {
    const a = await loadAt(ETH, '1h');
    const changed = vi.fn();
    const selection = vi.fn();
    a.onDrawingsChange(changed);
    a.onSelectionChange(selection);
    a.restoreDrawings([{ name: 'horizontalRayLine', points: [{ timestamp: D1, value: 7 }, { timestamp: D2, value: 7 }], lock: false }]);
    const o = userOverlays()[0]!;
    select(o);
    chart().overrideOverlay.mockClear();
    expect(a.setSelectedPrice(84123.45)).toBe(true);
    expect(chart().overrideOverlay).toHaveBeenCalledWith({ id: o.id, points: [{ timestamp: D1, value: 84123.45 }, { timestamp: D2, value: 84123.45 }] });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ price: { value: 84123.45, precision: 3 } }));
    expect(a.serializeDrawings()).toEqual([{ name: 'horizontalRayLine', points: [{ timestamp: D1, value: 84123.45 }, { timestamp: D2, value: 84123.45 }], lock: false }]);
  });

  it('setSelectedPrice rejects invalid prices, locked drawings and non-horizontal kinds', async () => {
    const a = await loadAt(ETH, '1h');
    a.restoreDrawings([
      { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 5 }], lock: true },
      { name: 'segment', points: [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }], lock: false },
      { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 5 }], lock: false },
    ]);
    const [locked, seg, free] = userOverlays();
    chart().overrideOverlay.mockClear();
    expect(a.setSelectedPrice(10)).toBe(false); // nothing selected
    select(locked!);
    expect(a.setSelectedPrice(10)).toBe(false);
    select(seg!);
    expect(a.setSelectedPrice(10)).toBe(false);
    select(free!);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(a.setSelectedPrice(bad)).toBe(false);
    expect(chart().overrideOverlay).not.toHaveBeenCalled();
  });

  it('changing only the price keeps anchorTf and the stored daily timestamps (also when shown remapped on intraday)', async () => {
    const anchored = { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 10 }], lock: false, anchorTf: '1D' as const };
    for (const tf of ['1D', '1h'] as const) {
      const a = await loadAt(AAPL, tf);
      a.restoreDrawings([anchored], AAPL.id);
      const o = userOverlays()[0]!;
      expect(o.points[0]!.timestamp).toBe(tf === '1h' ? OPEN1 : D1);
      select(o);
      a.setSelectedPrice(12.34);
      expect(o.points[0]!.timestamp, tf).toBe(tf === '1h' ? OPEN1 : D1);
      expect(a.serializeDrawings(), tf).toEqual([{ ...anchored, points: [{ timestamp: D1, value: 12.34 }] }]);
    }
  });

  it('a horizontal line placed with the mouse is rounded to the symbol precision; other drawings are not', async () => {
    const a = await loadAt(ETH, '1h');
    a.startDrawing('horizontalStraightLine');
    const h = userOverlays().at(-1)!;
    h.points = [{ timestamp: D1, value: 1234.567891 }];
    h.onDrawEnd?.({ overlay: h });
    expect(h.points).toEqual([{ timestamp: D1, value: 1234.568 }]);
    expect(a.serializeDrawings()[0]!.points).toEqual([{ timestamp: D1, value: 1234.568 }]);
    a.startDrawing('segment');
    const s = userOverlays().at(-1)!;
    s.points = [{ timestamp: D1, value: 1.23456 }, { timestamp: D2, value: 2.34567 }];
    s.onDrawEnd?.({ overlay: s });
    expect(s.points).toEqual([{ timestamp: D1, value: 1.23456 }, { timestamp: D2, value: 2.34567 }]);
  });

  it('a horizontal line dragged with the mouse is rounded too', async () => {
    const a = await loadAt(ETH, '1h');
    a.restoreDrawings([{ name: 'priceLine', points: [{ timestamp: D1, value: 5 }], lock: false }]);
    const o = userOverlays()[0]! as FakeOverlay & { onPressedMoveStart?: (e: unknown) => void };
    o.onPressedMoveStart?.({ overlay: o });
    o.points = [{ timestamp: D2, value: 6.66666 }];
    o.onPressedMoveEnd?.({ overlay: o });
    expect(a.serializeDrawings()[0]!.points).toEqual([{ timestamp: D2, value: 6.667 }]);
  });

  it('double-clicking a horizontal line selects it and requests the price editor', async () => {
    const a = await loadAt(ETH, '1h');
    const request = vi.fn();
    const off = a.onPriceEditRequest(request);
    a.restoreDrawings([
      { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 5 }], lock: false },
      { name: 'segment', points: [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }], lock: false },
    ]);
    const [h, s] = userOverlays() as Array<FakeOverlay & { onDoubleClick?: (e: unknown) => void }>;
    s!.onDoubleClick?.({ overlay: s });
    expect(request).not.toHaveBeenCalled();
    h!.onDoubleClick?.({ overlay: h });
    expect(a.getSelectedDrawing()).toMatchObject({ id: h!.id, price: { value: 5 } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(h!.id);
    off();
    h!.onDoubleClick?.({ overlay: h });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('ChartAdapter Shift constraint and price labels', () => {
  const D1 = Date.UTC(2024, 2, 4);
  const D2 = Date.UTC(2024, 6, 8);
  const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');
  const ETH: SymbolInfo = { id: 'crypto:ETH', assetClass: 'crypto', ticker: 'ETH', name: 'Ether', pricePrecision: 3 };

  async function loaded(symbol: SymbolInfo = ETH) {
    const a = make();
    a.load({ symbol, tf: '1h', session: 'rth', pollMs: 15000 }, events());
    vi.spyOn(api, 'bars').mockResolvedValue({
      symbol: symbol.id, tf: '1h', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [],
      bars: [{ ts: D1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    });
    const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
    await loader.getBars({ type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: { type: 'day', span: 1 }, callback: () => {} });
    return a;
  }
  type Live = FakeOverlay & { onPressedMoveStart?: (e: unknown) => void; onPressedMoving?: (e: unknown) => void };

  it('load passes the symbol precision to the template constraint; setShiftConstraint toggles it', async () => {
    const { drawingConstraint } = await import('../../src/chart/drawingTemplates');
    const a = await loaded();
    expect(drawingConstraint.precision).toBe(3);
    a.setShiftConstraint(true);
    expect(drawingConstraint.shift).toBe(true);
    a.setShiftConstraint(false);
    expect(drawingConstraint.shift).toBe(false);
  });

  it('the overlay being dragged is the one point moves may constrain; with Shift a whole drag stays horizontal', async () => {
    const { drawingConstraint } = await import('../../src/chart/drawingTemplates');
    const a = await loaded();
    a.restoreDrawings([{ name: 'segment', points: [{ timestamp: D1, value: 10 }, { timestamp: D2, value: 20 }], lock: false }]);
    const o = userOverlays()[0]! as Live;
    o.onPressedMoveStart?.({ overlay: o });
    expect(drawingConstraint.draggingId).toBe(o.id);
    o.points = [{ timestamp: D1, value: 11.11111 }, { timestamp: D2, value: 21 }];
    o.onPressedMoving?.({ overlay: o });
    expect(o.points.map((p) => p.value)).toEqual([11.11111, 21]); // no Shift: free
    a.setShiftConstraint(true);
    o.onPressedMoving?.({ overlay: o });
    expect(o.points.map((p) => p.value)).toEqual([11.111, 11.111]);
    o.onPressedMoveEnd?.({ overlay: o });
    expect(drawingConstraint.draggingId).toBeNull();
    expect(a.serializeDrawings()[0]!.points.map((p) => p.value)).toEqual([11.111, 11.111]);
    a.setShiftConstraint(false);
  });

  it('price line / horizontal line expose label toggles (defaults; persisted only when changed)', async () => {
    const a = await loaded();
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    a.restoreDrawings([
      { name: 'priceLine', points: [{ timestamp: D1, value: 5 }], lock: false, styles: { label: { onLine: false } } },
      { name: 'horizontalStraightLine', points: [{ timestamp: D1, value: 6 }], lock: false },
      { name: 'segment', points: [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }], lock: false },
    ]);
    const [p, h, s] = userOverlays();
    expect(p!.styles).toEqual({ chartmateLabel: { onLine: false } });
    p!.onSelected?.({ overlay: p });
    expect(a.getSelectedDrawing()).toMatchObject({ label: { onLine: false, onAxis: true } });
    s!.onSelected?.({ overlay: s });
    expect(a.getSelectedDrawing()).not.toHaveProperty('label');
    h!.onSelected?.({ overlay: h });
    expect(a.getSelectedDrawing()).toMatchObject({ label: { onLine: false, onAxis: true } });
    a.setSelectedLabel({ onLine: true });
    expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: h!.id, styles: { chartmateLabel: { onLine: true, onAxis: true } } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(a.getSelectedDrawing()).toMatchObject({ label: { onLine: true, onAxis: true } });
    expect(a.serializeDrawings()[1]!.styles).toEqual({ label: { onLine: true } });
    a.setSelectedLabel({ onLine: false }); // back to the default: nothing stored
    expect(a.serializeDrawings()[1]).not.toHaveProperty('styles');
    p!.onSelected?.({ overlay: p });
    a.setSelectedStyle({ color: '#ff0000' }); // a style change keeps the label options
    expect(a.serializeDrawings()[0]!.styles).toEqual({ line: { color: '#ff0000', size: 1, style: 'solid' }, label: { onLine: false } });
  });

  it('channels expose extend toggles: new finite by default, legacy extended; persisted only when changed', async () => {
    const a = await loaded();
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    const pts3 = [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }, { timestamp: D1, value: 3 }];
    a.restoreDrawings([
      { name: 'parallelChannel', points: pts3, lock: false },
      { name: 'parallelStraightLine', points: pts3, lock: false },
      { name: 'parallelChannel', points: pts3, lock: false, styles: { extend: { right: true } } },
      { name: 'segment', points: pts3.slice(0, 2), lock: false },
    ]);
    const [n, l, r, s] = userOverlays();
    expect(r!.styles).toEqual({ chartmateExtend: { right: true } });
    n!.onSelected?.({ overlay: n });
    expect(a.getSelectedDrawing()).toMatchObject({ kind: 'line', extend: { left: false, right: false } });
    l!.onSelected?.({ overlay: l });
    expect(a.getSelectedDrawing()).toMatchObject({ extend: { left: true, right: true } });
    r!.onSelected?.({ overlay: r });
    expect(a.getSelectedDrawing()).toMatchObject({ extend: { left: false, right: true } });
    s!.onSelected?.({ overlay: s });
    expect(a.getSelectedDrawing()).not.toHaveProperty('extend');

    n!.onSelected?.({ overlay: n });
    a.setSelectedExtend({ right: true });
    expect(chart().overrideOverlay).toHaveBeenLastCalledWith({ id: n!.id, styles: { chartmateExtend: { left: false, right: true } } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(a.getSelectedDrawing()).toMatchObject({ extend: { left: false, right: true } });
    expect(a.serializeDrawings()[0]!.styles).toEqual({ extend: { right: true } });
    a.setSelectedExtend({ right: false }); // back to the default: nothing stored
    expect(a.serializeDrawings()[0]).not.toHaveProperty('styles');
    a.setSelectedExtend({ right: true });
    a.setSelectedStyle({ color: '#ff0000' }); // a style change keeps the extend options
    const saved = a.serializeDrawings();
    expect(saved[0]).toMatchObject({ name: 'parallelChannel', styles: { line: { color: '#ff0000', size: 1, style: 'solid' }, extend: { right: true } } });
    expect(saved[1]).toEqual({ name: 'parallelStraightLine', points: pts3, lock: false }); // legacy: unchanged, no extend stored
    expect(saved[2]!.styles).toEqual({ extend: { right: true } });

    l!.onSelected?.({ overlay: l });
    a.setSelectedExtend({ left: false }); // legacy: turning one side off is stored against its (extended) defaults
    expect(a.serializeDrawings()[1]!.styles).toEqual({ extend: { left: false } });

    // Round trip: what is saved restores to the same drawings.
    const out = a.serializeDrawings();
    a.restoreDrawings(out);
    expect(a.serializeDrawings()).toEqual(out);
  });

  it('extend toggles are read-only for locked channels', async () => {
    const a = await loaded();
    a.restoreDrawings([{ name: 'parallelChannel', points: [{ timestamp: D1, value: 1 }, { timestamp: D2, value: 2 }, { timestamp: D1, value: 3 }], lock: true }]);
    const c = userOverlays()[0]!;
    c.onSelected?.({ overlay: c });
    chart().overrideOverlay.mockClear();
    a.setSelectedExtend({ left: true });
    expect(chart().overrideOverlay).not.toHaveBeenCalled();
  });

  it('label toggles are read-only for locked drawings', async () => {
    const a = await loaded();
    a.restoreDrawings([{ name: 'priceLine', points: [{ timestamp: D1, value: 5 }], lock: true }]);
    const p = userOverlays()[0]!;
    p.onSelected?.({ overlay: p });
    chart().overrideOverlay.mockClear();
    a.setSelectedLabel({ onAxis: false });
    expect(chart().overrideOverlay).not.toHaveBeenCalled();
  });
});

describe('indicator reference levels', () => {
  type Levels = { draw?: (p: unknown) => boolean; minValue?: number | null; maxValue?: number | null; figures?: unknown };
  const createArg = () => chart().createIndicator.mock.calls.at(-1)![0] as Levels;
  const lastOverride = () => chart().overrideIndicator.mock.calls.at(-1)![0] as Levels & { id: string };
  const fakeDraw = (draw: (p: unknown) => boolean) => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
      lineWidth: 0, strokeStyle: '',
    };
    const result = draw({ ctx, bounding: { width: 100, height: 100 }, yAxis: { convertToPixel: (v: number) => 100 - v } });
    return { result, ctx, ys: ctx.moveTo.mock.calls.map((c) => c[1] as number) };
  };

  it('oscillators get a draw callback with their default levels and a y-range that keeps them visible', () => {
    const a = make();
    a.addIndicator({ name: 'RSI', pane: 'sub' });
    const c = createArg();
    expect(c).toMatchObject({ minValue: 30, maxValue: 70 });
    const { result, ys, ctx } = fakeDraw(c.draw!);
    expect(result).toBe(false); // default figures still drawn (on top)
    expect(ys).toEqual([30.5, 70.5]);
    expect(ctx.strokeStyle).toMatch(/^#[0-9a-f]{6}$/i); // the opaque level token
    a.addIndicator({ name: 'MACD', pane: 'sub' });
    expect(createArg()).toMatchObject({ minValue: 0, maxValue: 0 });
  });

  it('overlays and indicators without catalog levels get no draw / range fields', () => {
    const a = make();
    a.addIndicator({ name: 'MA', pane: 'main' });
    expect(createArg()).not.toHaveProperty('draw');
    a.addIndicator({ name: 'VOL', pane: 'sub' });
    expect(createArg()).not.toHaveProperty('draw');
    expect(createArg()).not.toHaveProperty('minValue');
  });

  it('stored levels and showLevels: false are honored on create and listed back', () => {
    const a = make();
    const id = a.addIndicator({ name: 'KDJ', pane: 'sub', levels: [90, 50, 10] });
    expect(createArg()).toMatchObject({ minValue: 10, maxValue: 90 });
    expect(fakeDraw(createArg().draw!).ys).toEqual([10.5, 50.5, 90.5]);
    const hidden = a.addIndicator({ name: 'CCI', pane: 'sub', showLevels: false });
    expect(createArg()).toMatchObject({ minValue: null, maxValue: null });
    expect(fakeDraw(createArg().draw!).ctx.stroke).not.toHaveBeenCalled();
    expect(a.listIndicators().find((i) => i.id === id)).toMatchObject({ levels: [90, 50, 10] });
    expect(a.listIndicators().find((i) => i.id === hidden)).toMatchObject({ showLevels: false });
  });

  it('updateIndicator rewrites the levels only when they change; removing the override restores the defaults', () => {
    const a = make();
    const id = a.addIndicator({ name: 'RSI', pane: 'sub' });
    a.updateIndicator(id, { calcParams: [14, 12, 24] });
    expect(lastOverride()).not.toHaveProperty('draw'); // same levels: untouched
    a.updateIndicator(id, { calcParams: [14, 12, 24], showLevels: false });
    expect(lastOverride()).toMatchObject({ id, minValue: null, maxValue: null });
    expect(fakeDraw(lastOverride().draw!).ctx.stroke).not.toHaveBeenCalled();
    a.updateIndicator(id, { levels: [80, 20] });
    expect(lastOverride()).toMatchObject({ minValue: 20, maxValue: 80 });
    a.updateIndicator(id, {});
    expect(lastOverride()).toMatchObject({ minValue: 30, maxValue: 70 });
    expect(fakeDraw(lastOverride().draw!).ys).toEqual([30.5, 70.5]);
    expect(a.listIndicators()[0]).not.toHaveProperty('levels');
  });

  it('the levels follow the theme (color read at draw time) and survive style overrides and the solid-bars figures', () => {
    const a = make();
    const create = chart().createIndicator.getMockImplementation()!;
    chart().createIndicator.mockImplementationOnce((v, stack) => {
      const id = create(v, stack);
      const figures = [{ key: 'ao', type: 'bar', styles: () => ({ style: 'stroke', color: '#00ff00' }) }];
      Object.assign(chart().indicators.find((i) => i.id === id)!, { figures });
      return id;
    });
    const id = a.addIndicator({ name: 'AO', pane: 'sub' });
    const draw = createArg().draw!;
    expect(lastOverride()).toMatchObject({ id, figures: expect.any(Array) });
    expect(lastOverride()).not.toHaveProperty('draw'); // solid bars do not touch the levels
    const dark = fakeDraw(draw).ctx.strokeStyle;
    chart().overrideIndicator.mockClear();
    a.setTheme('light');
    for (const [o] of chart().overrideIndicator.mock.calls) expect(o).not.toHaveProperty('draw');
    expect(fakeDraw(draw).ctx.strokeStyle).not.toBe(dark);
    a.updateIndicator(id, { barColors: { up: '#00ff00', down: '#ff0000' } });
    expect(lastOverride()).not.toHaveProperty('draw');
  });
});

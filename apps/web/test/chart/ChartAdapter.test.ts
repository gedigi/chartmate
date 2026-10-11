import type { SymbolInfo } from '@altv/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOverlay {
  id: string; name: string; groupId: string; points: Array<{ timestamp: number; value: number }>; lock: boolean;
  extendData: unknown; styles: unknown; onRemoved?: (e: unknown) => void; onDrawEnd?: (e: unknown) => void; onPressedMoveEnd?: (e: unknown) => void;
}
interface FakeIndicator { id: string; name: string; paneId: string; calcParams: number[]; visible: boolean; styles: unknown }

const k = vi.hoisted(() => {
  const state = { chart: null as unknown as ReturnType<typeof makeChart>, registered: [] as string[] };
  function makeChart() {
    let seq = 0;
    const overlays: FakeOverlay[] = [];
    const indicators: FakeIndicator[] = [];
    const data: Array<{ timestamp: number; high: number }> = [];
    const chart = {
      overlays, indicators, data,
      setStyles: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), setTimezone: vi.fn(),
      resize: vi.fn(), getDataList: vi.fn(() => data),
      getStyles: vi.fn(() => ({ indicator: { lines: [{ color: '#d1' }, { color: '#d2' }, { color: '#d3' }] } })),
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
      removeOverlay: vi.fn((f: { id?: string; groupId?: string }) => {
        for (let i = overlays.length - 1; i >= 0; i--) {
          const o = overlays[i]!;
          if ((f.id && o.id === f.id) || (f.groupId && o.groupId === f.groupId)) {
            overlays.splice(i, 1);
            o.onRemoved?.({ overlay: o });
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
  };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: k.dispose,
  registerIndicator: k.registerIndicator,
  getSupportedIndicators: () => k.state.registered,
}));

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const events = () => ({ onMeta: vi.fn(), onError: vi.fn() });

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
      id, calcParams: [50], visible: false, styles: { lines: [{ color: '#fff' }] },
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
      id, calcParams: [30], styles: { lines: [{ color: '#d1' }, { color: '#d2' }, { color: '#d3' }] },
    }));
    expect(a.listIndicators()[0]!.lineColors).toBeUndefined();
    chart().overrideIndicator.mockClear();
    a.updateIndicator(id, { visible: false });
    expect(chart().overrideIndicator.mock.calls[0]![0]).not.toHaveProperty('styles');
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

  it('setMarkers places locked simpleAnnotations in group markers at the bar high', () => {
    const a = make();
    chart().data.push({ timestamp: 1000, high: 10 }, { timestamp: 2000, high: 20 }, { timestamp: 3000, high: 30 });
    a.setMarkers([{ ts: 2000, label: 'v2' }, { ts: 2500, label: 'v3' }, { ts: 9999, label: 'future' }]);
    const ms = chart().overlays.filter((o) => o.groupId === 'markers');
    expect(ms.map((o) => ({ name: o.name, lock: o.lock, points: o.points, text: o.extendData }))).toEqual([
      { name: 'simpleAnnotation', lock: true, points: [{ timestamp: 2000, value: 20 }], text: 'v2' },
      { name: 'simpleAnnotation', lock: true, points: [{ timestamp: 3000, value: 30 }], text: 'v3' },
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

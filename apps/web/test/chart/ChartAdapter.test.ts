import type { SymbolInfo } from '@altv/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOverlay {
  id: string; name: string; groupId: string; points: Array<{ timestamp: number; value: number }>; lock: boolean;
  extendData: unknown; styles: unknown; onRemoved?: (e: unknown) => void; onDrawEnd?: (e: unknown) => void; onPressedMoveEnd?: (e: unknown) => void;
  onSelected?: (e: unknown) => void; onDeselected?: (e: unknown) => void; mode?: string;
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
  };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: k.dispose,
  registerIndicator: k.registerIndicator,
  getSupportedIndicators: () => k.state.registered,
}));

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');

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
      await vi.waitFor(() => expect(ev.onError).toHaveBeenCalled());
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

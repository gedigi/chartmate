import type { Layout } from '@altv/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { DEFAULT_LAYOUT, useLayout } from '../src/state/useLayout';

const saved: Layout = { symbol: 'stock:AAPL', tf: '1h', session: 'rth', chartType: 'candle', indicators: [] };
const msftSym: Layout = { ...saved, symbol: 'stock:MSFT', indicators: [{ name: 'MA', pane: 'main', calcParams: [20], visible: true }] };

let put: MockInstance<typeof api.layouts.put>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(api.layouts, 'get').mockImplementation(async (key) =>
    key === 'default' ? saved : key === 'sym:stock:MSFT' ? msftSym : null);
  put = vi.spyOn(api.layouts, 'put').mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });

describe('useLayout', () => {
  it('starts from DEFAULT_LAYOUT and loads the saved default without re-saving it', async () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual(saved);
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it('adopts per-symbol indicators on symbol change and saves only the default key for a mere visit', async () => {
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'stock:MSFT' })));
    await waitFor(() => expect(result.current.layout.indicators).toEqual(msftSym.indicators));
    await settle();
    expect(put.mock.calls.map((c) => c[0])).toEqual(['default']);
    expect(put.mock.calls[0]![1]).toMatchObject({ symbol: 'stock:MSFT', indicators: msftSym.indicators });
  });

  it('saves the per-symbol key when the layout changes for that symbol', async () => {
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, indicators: [{ name: 'RSI', pane: 'sub', calcParams: [14], visible: true }] })));
    await settle();
    expect(put.mock.calls.map((c) => c[0]).sort()).toEqual(['default', 'sym:stock:AAPL']);
  });

  it('only writes the per-symbol key when indicators change (by value), not on tf/chartType changes', async () => {
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, tf: '1D' })));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, chartType: 'line' })));
    await settle();
    // Same indicators, new array identity: still not a change.
    act(() => result.current.setLayout((l) => ({ ...l, indicators: l.indicators.map((i) => ({ ...i })) })));
    await settle();
    expect(put.mock.calls.some((c) => c[0] === 'default')).toBe(true);
    expect(put.mock.calls.filter((c) => c[0].startsWith('sym:'))).toEqual([]);
  });
});

describe('useLayout appearance (global, default key only)', () => {
  const appearance = { upColor: '#00ff00', drawing: { color: '#123456', size: 2, style: 'dashed' as const } };

  it('loads appearance from default, keeps it across symbol switches and never writes it to sym: keys', async () => {
    vi.mocked(api.layouts.get).mockImplementation(async (key) =>
      key === 'default' ? { ...saved, appearance } : key === 'sym:stock:MSFT' ? { ...msftSym, appearance: { upColor: '#ff0000' } } : null);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout.appearance).toEqual(appearance);
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'stock:MSFT' })));
    await waitFor(() => expect(result.current.layout.indicators).toEqual(msftSym.indicators));
    expect(result.current.layout.appearance).toEqual(appearance); // a sym: layout never brings its own
    act(() => result.current.setLayout((l) => ({ ...l, indicators: [] })));
    await settle();
    const sym = put.mock.calls.filter((c) => c[0] === 'sym:stock:MSFT');
    expect(sym).toHaveLength(1);
    expect(sym[0]![1]).not.toHaveProperty('appearance');
    expect(put.mock.calls.filter((c) => c[0] === 'default').at(-1)![1]).toMatchObject({ appearance });
  });

  it('an appearance change saves the default key only', async () => {
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, appearance })));
    await settle();
    expect(put.mock.calls.map((c) => c[0])).toEqual(['default']);
    expect(put.mock.calls[0]![1]).toMatchObject({ appearance });
  });
});

/** Promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useLayout per-symbol load races', () => {
  const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [14], visible: true };
  const macd = { name: 'MACD', pane: 'sub' as const, calcParams: [12, 26, 9], visible: true };
  const ma = { name: 'MA', pane: 'main' as const, calcParams: [50], visible: true };

  it('keeps indicator edits made on a symbol before its sym: layout resolves (and saves them under that symbol)', async () => {
    const msft = deferred<Layout | null>();
    vi.mocked(api.layouts.get).mockImplementation(async (key) =>
      key === 'default' ? saved : key === 'sym:stock:MSFT' ? msft.promise : null);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'stock:MSFT' })));
    act(() => result.current.setLayout((l) => ({ ...l, indicators: [rsi] })));
    await act(async () => { msft.resolve({ ...saved, symbol: 'stock:MSFT', indicators: [macd] }); await Promise.resolve(); });
    await settle();
    expect(result.current.layout.indicators).toEqual([rsi]);
    const symPuts = put.mock.calls.filter((c) => c[0].startsWith('sym:'));
    expect(symPuts.map((c) => [c[0], c[1].indicators])).toEqual([['sym:stock:MSFT', [rsi]]]);
  });

  it('A→B→A: B\'s indicators are never applied to A and never saved under A', async () => {
    const aaplLoads: ReturnType<typeof deferred<Layout | null>>[] = [];
    const msft = deferred<Layout | null>();
    vi.mocked(api.layouts.get).mockImplementation((key) => {
      if (key === 'default') return Promise.resolve(saved);
      if (key === 'sym:stock:MSFT') return msft.promise;
      const d = deferred<Layout | null>();
      aaplLoads.push(d);
      return d.promise;
    });
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { aaplLoads[0]!.resolve({ ...saved, indicators: [ma] }); await Promise.resolve(); });
    await waitFor(() => expect(result.current.layout.indicators).toEqual([ma]));
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'stock:MSFT' })));
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'stock:AAPL' })));
    await act(async () => { msft.resolve({ ...saved, symbol: 'stock:MSFT', indicators: [macd] }); await Promise.resolve(); });
    expect(result.current.layout.indicators).toEqual([ma]);
    await act(async () => { aaplLoads[1]!.resolve({ ...saved, indicators: [ma] }); await Promise.resolve(); });
    await settle();
    expect(result.current.layout).toMatchObject({ symbol: 'stock:AAPL', indicators: [ma] });
    for (const [key, l] of put.mock.calls) {
      if (key === 'sym:stock:AAPL') expect(l.indicators).toEqual([ma]);
      expect(key).not.toBe('sym:stock:MSFT');
    }
  });
});

describe('useLayout load failures and early edits', () => {
  it('a non-404 failure of the default load never adopts DEFAULT_LAYOUT or saves; it retries with backoff', async () => {
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') throw new ApiError(500, 'internal', 'boom');
      return null;
    });
    const { result } = renderHook(() => useLayout());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(false);
    expect(result.current.loadError).toBe('boom');
    act(() => result.current.setLayout((l) => ({ ...l, tf: '1m' })));
    await settle();
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
    expect(put).not.toHaveBeenCalled();
    const calls = () => vi.mocked(api.layouts.get).mock.calls.filter((c) => c[0] === 'default').length;
    const before = calls();
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? saved : null));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls()).toBeGreaterThan(before);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBeNull();
    expect(result.current.layout).toEqual(saved);
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it('retry() reloads the default layout at once', async () => {
    let fail = true;
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') { if (fail) throw new ApiError(0, 'network_error', 'offline'); return saved; }
      return null;
    });
    const { result } = renderHook(() => useLayout());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loadError).toBe('offline');
    fail = false;
    act(() => result.current.retry());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.layout).toEqual(saved);
  });

  it('a symbol selected before the default layout loads is applied on top of it (and saved)', async () => {
    const d = deferred<Layout | null>();
    vi.mocked(api.layouts.get).mockImplementation((key) => (key === 'default' ? d.promise : Promise.resolve(null)));
    const { result } = renderHook(() => useLayout());
    act(() => result.current.selectSymbol('stock:MSFT'));
    expect(result.current.layout.symbol).toBe(DEFAULT_LAYOUT.symbol);
    await act(async () => { d.resolve(saved); await Promise.resolve(); });
    await waitFor(() => expect(result.current.layout).toEqual({ ...saved, symbol: 'stock:MSFT' }));
    await settle();
    expect(put).toHaveBeenCalledWith('default', expect.objectContaining({ symbol: 'stock:MSFT', tf: saved.tf }));
  });

  it('an indicator edit made while the sym: load keeps failing is saved once that load succeeds', async () => {
    const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [14], visible: true };
    let symFails = true;
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') return saved;
      if (symFails) throw new ApiError(503, 'unavailable', 'down');
      return { ...saved, indicators: [] };
    });
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setLayout((l) => ({ ...l, indicators: [rsi] })));
    await settle();
    expect(put.mock.calls.filter((c) => c[0].startsWith('sym:'))).toEqual([]);
    symFails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await settle();
    const symPuts = put.mock.calls.filter((c) => c[0] === 'sym:stock:AAPL');
    expect(symPuts.length).toBeGreaterThanOrEqual(1);
    expect(symPuts.at(-1)![1].indicators).toEqual([rsi]);
    expect(result.current.layout.indicators).toEqual([rsi]);
  });
});

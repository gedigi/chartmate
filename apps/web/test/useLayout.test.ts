import type { Layout } from '@altv/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { api } from '../src/api/client';
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

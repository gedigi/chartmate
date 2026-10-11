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
});

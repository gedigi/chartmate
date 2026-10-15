import type { Basket } from '@chartmate/shared';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { DrawingsSavers } from '../src/components/DrawingsSave';
import { drawingsStore } from '../src/state/drawingsStore';
import { onBasketChanged, onBasketDeleted, useBaskets } from '../src/state/useBaskets';

const B: Basket = { id: 'b1', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } }] };

beforeEach(() => {
  drawingsStore.reset();
  vi.spyOn(api.baskets, 'list').mockResolvedValue([B]);
  vi.spyOn(api.baskets, 'remove').mockResolvedValue(undefined);
  vi.spyOn(api, 'quotes').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('useBaskets change events', () => {
  it('notifies subscribers after upsert (create/update/appendVersion results) and remove', async () => {
    const seen: string[] = [];
    const off = onBasketChanged((id) => seen.push(id));
    const { result } = renderHook(() => useBaskets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.upsert({ ...B, name: 'Renamed' }));
    await act(async () => { await result.current.remove('b1'); });
    off();
    act(() => result.current.upsert({ ...B, id: 'b2' }));
    expect(seen).toEqual(['b1', 'b1']);
  });
});

describe('useBaskets remove cleans up references', () => {
  it('drops the basket from the stored watchlist, clears its drawings and announces the deletion', async () => {
    vi.spyOn(api.watchlist, 'get').mockResolvedValue([{ type: 'symbol', id: 'stock:AAPL' }, { type: 'symbol', id: 'basket:b1' }]);
    const putWl = vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
    const putDrawings = vi.spyOn(api.drawings, 'put').mockResolvedValue(undefined);
    const deleted: string[] = [];
    const off = onBasketDeleted((id) => deleted.push(id));
    const { result } = renderHook(() => useBaskets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.remove('b1'); });
    off();
    await waitFor(() => expect(putWl).toHaveBeenCalledWith([{ type: 'symbol', id: 'stock:AAPL' }]));
    expect(putDrawings).toHaveBeenCalledWith('basket:b1', []);
    expect(deleted).toEqual(['b1']);
  });

  it('does not wait for the cleanup: the delete resolves while the watchlist request is still pending', async () => {
    let release!: (v: never[]) => void;
    vi.spyOn(api.watchlist, 'get').mockReturnValue(new Promise((r) => { release = r; }));
    vi.spyOn(api.drawings, 'put').mockResolvedValue(undefined);
    const { result } = renderHook(() => useBaskets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.remove('b1'); });
    expect(result.current.baskets).toEqual([]);
    release([]);
  });

  it('leaves a watchlist without the basket untouched; cleanup failures do not fail the delete', async () => {
    vi.spyOn(api.watchlist, 'get').mockResolvedValue([{ type: 'symbol', id: 'stock:AAPL' }]);
    const putWl = vi.spyOn(api.watchlist, 'put').mockResolvedValue(undefined);
    vi.spyOn(api.drawings, 'put').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useBaskets());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.remove('b1'); });
    expect(putWl).not.toHaveBeenCalled();
    expect(result.current.baskets).toEqual([]);
  });
});

describe('useBaskets remove cancels the basket\'s unsaved drawings', () => {
  it('a drawings save still retrying at delete time is canceled: nothing re-saves the deleted basket\'s drawings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api.watchlist, 'get').mockResolvedValue([]);
      const sym = 'basket:b1' as const;
      const drawings = [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }];
      const put = vi.spyOn(api.drawings, 'put').mockImplementation(async (_s, d) => { if (d.length > 0) throw new Error('offline'); });
      render(createElement(DrawingsSavers));
      act(() => drawingsStore.setActive(sym));
      act(() => drawingsStore.setValue(sym, drawings));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // the save fails: retried later
      act(() => drawingsStore.setActive(null));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const before = put.mock.calls.filter((c) => c[1].length > 0).length;
      const { result } = renderHook(() => useBaskets());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => { await result.current.remove('b1'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
      expect(before).toBeGreaterThanOrEqual(1); // the save was failing and being retried
      expect(put.mock.calls.filter((c) => c[1].length > 0)).toHaveLength(before);
      expect(put).toHaveBeenLastCalledWith(sym, []); // only the cleanup
      expect(drawingsStore.getSnapshot().values.has(sym)).toBe(false);
      expect(drawingsStore.getSnapshot().statuses.has(sym)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

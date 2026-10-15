import type { Basket } from '@chartmate/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { onBasketChanged, onBasketDeleted, useBaskets } from '../src/state/useBaskets';

const B: Basket = { id: 'b1', name: 'B1', baseValue: 100, createdAt: 0, updatedAt: 0, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } }] };

beforeEach(() => {
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
    expect(putWl).toHaveBeenCalledWith([{ type: 'symbol', id: 'stock:AAPL' }]);
    expect(putDrawings).toHaveBeenCalledWith('basket:b1', []);
    expect(deleted).toEqual(['b1']);
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

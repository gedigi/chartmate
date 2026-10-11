import type { Basket } from '@altv/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { onBasketChanged, useBaskets } from '../src/state/useBaskets';

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

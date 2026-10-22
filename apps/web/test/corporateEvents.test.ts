import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { corporateEvents, EVENTS_TTL_MS, resetCorporateEvents } from '../src/state/corporateEvents';

afterEach(() => { resetCorporateEvents(); vi.restoreAllMocks(); });

describe('corporateEvents', () => {
  const events = [{ kind: 'dividend' as const, ts: 1, amount: 0.2 }];

  it('asks the server once per symbol for an hour; concurrent calls share the request', async () => {
    let now = 1_000;
    const spy = vi.spyOn(api, 'events').mockResolvedValue({ symbol: 'stock:AAPL', events });
    const [a, b] = await Promise.all([corporateEvents('stock:AAPL', () => now), corporateEvents('stock:AAPL', () => now)]);
    expect(a).toEqual(events);
    expect(b).toEqual(events);
    now += EVENTS_TTL_MS - 1;
    await corporateEvents('stock:AAPL', () => now);
    expect(spy).toHaveBeenCalledTimes(1);
    now += 1;
    await corporateEvents('stock:AAPL', () => now);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a failure is not cached', async () => {
    const spy = vi.spyOn(api, 'events').mockRejectedValueOnce(new Error('down')).mockResolvedValue({ symbol: 'stock:AAPL', events });
    await expect(corporateEvents('stock:AAPL')).rejects.toThrow('down');
    expect(await corporateEvents('stock:AAPL')).toEqual(events);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

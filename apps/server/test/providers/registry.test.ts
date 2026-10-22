import { describe, expect, it } from 'vitest';
import { createRegistry } from '../../src/providers/registry.js';
import type { YahooLike } from '../../src/providers/yahoo.js';

const yahooClient: YahooLike = {
  chart: async () => ({ meta: {}, quotes: [] }),
  search: async () => ({ quotes: [] }),
  quote: async () => [],
  quoteSummary: async () => ({}),
};
const fetchImpl = (async () => new Response('[]')) as typeof fetch;
const base = { binanceBaseUrl: 'https://data-api.binance.vision', fetchImpl, yahooClient };

describe('createRegistry', () => {
  it('fixture mode uses fixture providers for both asset classes', () => {
    const r = createRegistry({ ...base, mode: 'fixture', cryptoProvider: 'binance' });
    expect([r.stock.id, r.stock.assetClass]).toEqual(['fixture', 'stock']);
    expect([r.crypto.id, r.crypto.assetClass]).toEqual(['fixture', 'crypto']);
  });

  it('live mode: yahoo for stocks, configured crypto provider', () => {
    const b = createRegistry({ ...base, mode: 'live', cryptoProvider: 'binance' });
    expect(b.stock.id).toBe('yahoo');
    expect(b.crypto.id).toBe('binance');
    const c = createRegistry({ ...base, mode: 'live', cryptoProvider: 'coinbase' });
    expect(c.crypto.id).toBe('coinbase');
  });
});

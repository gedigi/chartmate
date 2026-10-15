import { describe, expect, it } from 'vitest';
import { normalizeSymbolId, parseSymbolId, tryNormalizeSymbolId } from '../src/types.js';
import { normalizeWatchlist } from '../src/watchlist.js';

const UUID = '3f2b6c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60';

describe('symbol ids', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(parseSymbolId('crypto:btc')).toEqual({ assetClass: 'crypto', code: 'BTC' });
    expect(normalizeSymbolId(' stock:aapl ')).toBe('stock:AAPL');
    expect(normalizeSymbolId('stock: msft')).toBe('stock:MSFT');
    expect(normalizeSymbolId(`basket:${UUID.toUpperCase()}`)).toBe(`basket:${UUID}`);
  });

  it('trims leading and trailing whitespace of any kind before the ASCII check', () => {
    expect(normalizeSymbolId('\tstock:aapl\n')).toBe('stock:AAPL');
    expect(normalizeSymbolId('\r\n crypto:btc \u00a0')).toBe('crypto:BTC');
    expect(normalizeSymbolId(` basket:${UUID}${' '.repeat(120)}`)).toBe(`basket:${UUID}`);
    // Inside the id, only plain ASCII is accepted.
    for (const bad of ['stock:\taapl', 'stock\n:AAPL', 'crypto:\u00a0btc']) expect(tryNormalizeSymbolId(bad), JSON.stringify(bad)).toBeNull();
  });

  it('accepts the real stock shapes: share classes, indices, futures, numeric tickers', () => {
    for (const code of ['AAPL', 'BRK-B', 'BRK.B', '^GSPC', 'ES=F', 'EURUSD=X', '0700.HK', 'A']) {
      expect(normalizeSymbolId(`stock:${code}`)).toBe(`stock:${code}`);
    }
    expect(normalizeSymbolId('crypto:1000SATS')).toBe('crypto:1000SATS');
  });

  it('rejects codes that could alter a provider URL', () => {
    for (const bad of [
      'stock:AAPL/../x', 'stock:AAPL?x=1', 'stock:AAPL#x', 'stock:A B', 'stock:%2F', 'stock:.AAPL', 'stock:-A',
      'stock:ABCDEFGHIJKLMNOPQRSTU', 'crypto:BTC-USD', 'crypto:BTC/USDT', 'crypto:BTC.X', 'basket:abc',
      `basket:${UUID}x`, 'stock:', 'AAPL', 'fx:EURUSD', 'Stock:AAPL', '',
    ]) {
      expect(() => parseSymbolId(bad), bad).toThrow();
      expect(tryNormalizeSymbolId(bad), bad).toBeNull();
    }
    expect(tryNormalizeSymbolId(42)).toBeNull();
    // Case folding of non-ASCII letters must not alias another ticker (ß → SS, ı → I).
    for (const bad of ['stock:ß', 'stock:maß', 'crypto:ıd', 'stock:ＡＡＰＬ']) expect(tryNormalizeSymbolId(bad), bad).toBeNull();
    expect(() => parseSymbolId(`stock:${'A'.repeat(200)}`)).toThrow();
  });

  it('normalizeWatchlist normalizes ids, merges case variants and drops invalid ones', () => {
    expect(normalizeWatchlist(['stock:aapl', 'stock:AAPL', 'crypto:btc', 'stock:bad/one'])).toEqual([
      { type: 'symbol', id: 'stock:AAPL' }, { type: 'symbol', id: 'crypto:BTC' },
    ]);
  });
});

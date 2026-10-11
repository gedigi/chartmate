import { describe, it, expect } from 'vitest';
import { TIMEFRAMES, tfMs, isIntraday, baseTimeframe, isTimeframe } from '../src/timeframes.js';
import { parseSymbolId } from '../src/types.js';

describe('timeframes', () => {
  it('lists all ten in order', () => {
    expect(TIMEFRAMES).toEqual(['1m','5m','15m','30m','1h','2h','4h','1D','1W','1M']);
  });
  it('tfMs', () => {
    expect(tfMs('1m')).toBe(60_000);
    expect(tfMs('4h')).toBe(4 * 3_600_000);
    expect(tfMs('1D')).toBe(86_400_000);
  });
  it('intraday + base', () => {
    expect(isIntraday('1h')).toBe(true);
    expect(isIntraday('1D')).toBe(false);
    expect(baseTimeframe('4h')).toBe('1h');
    expect(baseTimeframe('2h')).toBe('1h');
    expect(baseTimeframe('1W')).toBe('1D');
    expect(baseTimeframe('1M')).toBe('1D');
    expect(baseTimeframe('15m')).toBe('15m');
  });
  it('guards', () => {
    expect(isTimeframe('1D')).toBe(true);
    expect(isTimeframe('1d')).toBe(false);
  });
  it('parseSymbolId', () => {
    expect(parseSymbolId('stock:AAPL')).toEqual({ assetClass: 'stock', code: 'AAPL' });
    expect(parseSymbolId('crypto:BTC')).toEqual({ assetClass: 'crypto', code: 'BTC' });
    expect(() => parseSymbolId('AAPL')).toThrow();
    expect(() => parseSymbolId('fx:EURUSD')).toThrow();
    expect(() => parseSymbolId('stock:')).toThrow();
  });
});

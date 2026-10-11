import { describe, expect, it } from 'vitest';
import { nyParts, tfMs, type NativeTimeframe } from '@altv/shared';
import { FixtureProvider } from '../../src/providers/fixture.js';
import { NotFoundError } from '../../src/errors.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');

const stock = () => new FixtureProvider({ assetClass: 'stock', now: () => NOW });
const crypto = () => new FixtureProvider({ assetClass: 'crypto', now: () => NOW });

describe('FixtureProvider', () => {
  it('identity and no limits', () => {
    const p = stock();
    expect(p.id).toBe('fixture');
    expect(p.assetClass).toBe('stock');
    expect(crypto().assetClass).toBe('crypto');
    expect(p.limits).toEqual({ maxLookbackMs: {}, maxSpanPerRequestMs: {} });
  });

  it('same inputs → identical outputs across instances', async () => {
    const from = Date.parse('2026-09-01T00:00:00Z');
    const to = Date.parse('2026-09-08T00:00:00Z');
    for (const tf of ['5m', '1h', '1D'] as NativeTimeframe[]) {
      expect(await stock().fetchBars('AAPL', tf, from, to)).toEqual(await new FixtureProvider({ assetClass: 'stock' }).fetchBars('AAPL', tf, from, to));
      expect(await crypto().fetchBars('BTC', tf, from, to)).toEqual(await crypto().fetchBars('BTC', tf, from, to));
    }
  });

  it('different symbols produce different series', async () => {
    const from = Date.parse('2026-09-01T00:00:00Z');
    const a = await stock().fetchBars('AAPL', '1D', from, from + 10 * DAY);
    const m = await stock().fetchBars('MSFT', '1D', from, from + 10 * DAY);
    expect(a.bars[0]!.close).not.toBe(m.bars[0]!.close);
  });

  it('stock intraday bars: weekdays only, within 04:00–20:00 NY, all tagged incl. pre and post', async () => {
    const from = Date.parse('2026-09-04T00:00:00Z'); // Fri
    const to = Date.parse('2026-09-09T00:00:00Z'); // through Tue
    const { bars } = await stock().fetchBars('SPY', '15m', from, to);
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) {
      const p = nyParts(b.ts);
      expect(p.dow).toBeGreaterThanOrEqual(1);
      expect(p.dow).toBeLessThanOrEqual(5);
      const min = p.hh * 60 + p.mm;
      expect(min).toBeGreaterThanOrEqual(240);
      expect(min).toBeLessThan(1200);
      expect(b.session).toBeDefined();
    }
    expect(new Set(bars.map((b) => b.session))).toEqual(new Set(['pre', 'regular', 'post']));
    // 16h × 4 bars/h per weekday: Fri, Mon, Tue (the Friday starts at NY 00:00 → 04:00 included)
    expect(bars).toHaveLength(3 * 64);
  });

  it('bars are within [from, to), on the native grid, sorted, with consistent OHLC', async () => {
    const from = Date.parse('2026-09-01T00:07:00Z');
    const to = Date.parse('2026-09-03T05:00:00Z');
    for (const tf of ['1m', '5m', '30m', '1h'] as NativeTimeframe[]) {
      const { bars } = await crypto().fetchBars('ETH', tf, from, to);
      expect(bars.length).toBeGreaterThan(0);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        expect(b.ts).toBeGreaterThanOrEqual(from);
        expect(b.ts).toBeLessThan(to);
        expect(b.ts % tfMs(tf)).toBe(0);
        if (i > 0) expect(b.ts - bars[i - 1]!.ts).toBe(tfMs(tf)); // crypto is 24/7, no gaps
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
        expect(b.volume).toBeGreaterThan(0);
        expect(b.session).toBeUndefined();
      }
    }
  });

  it('daily: stocks weekdays only, crypto every day; ts at UTC midnight', async () => {
    const from = Date.UTC(2026, 8, 1);
    const to = Date.UTC(2026, 8, 15);
    const s = await stock().fetchBars('AAPL', '1D', from, to);
    const c = await crypto().fetchBars('BTC', '1D', from, to);
    expect(c.bars).toHaveLength(14);
    expect(s.bars).toHaveLength(10);
    for (const b of [...s.bars, ...c.bars]) {
      expect(b.ts % DAY).toBe(0);
      expect(b.session).toBeUndefined();
    }
    for (const b of s.bars) expect([0, 6]).not.toContain(new Date(b.ts).getUTCDay());
  });

  it('never returns future bars and starts no earlier than firstBarTs', async () => {
    const { bars } = await crypto().fetchBars('BTC', '1h', NOW - 3 * 3_600_000, NOW + DAY);
    expect(bars.at(-1)!.ts).toBeLessThan(NOW);
    const early = await stock().fetchBars('AAPL', '1D', Date.UTC(2014, 11, 25), Date.UTC(2015, 0, 10));
    expect(early.bars[0]!.ts).toBe(Date.UTC(2015, 0, 1));
  });

  it('unknown or wrong-class code → NotFoundError', async () => {
    await expect(stock().fetchBars('ZZZ', '1h', NOW - DAY, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(stock().fetchBars('BTC', '1h', NOW - DAY, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(crypto().firstBarTs('AAPL')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('firstBarTs: 2015-01-01, BTC 2014-01-01', async () => {
    expect(await stock().firstBarTs('AAPL')).toBe(Date.UTC(2015, 0, 1));
    expect(await crypto().firstBarTs('ETH')).toBe(Date.UTC(2015, 0, 1));
    expect(await crypto().firstBarTs('BTC')).toBe(Date.UTC(2014, 0, 1));
  });

  it('search matches ticker or name within its asset class', async () => {
    expect((await stock().search('aap')).map((s) => s.id)).toEqual(['stock:AAPL']);
    expect((await stock().search('micro')).map((s) => s.id)).toEqual(['stock:MSFT']);
    expect((await stock().search('s')).map((s) => s.id)).toEqual(['stock:SPY', 'stock:MSFT']); // ticker prefix, then contains
    expect((await stock().search('')).map((s) => s.id)).toEqual(['stock:AAPL', 'stock:MSFT', 'stock:SPY']);
    expect((await crypto().search('eth')).map((s) => s.id)).toEqual(['crypto:ETH']);
    expect((await crypto().search('bitcoin'))[0]).toMatchObject({ id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC' });
  });

  it('quotes come from the latest generated bar', async () => {
    const q = await crypto().quotes(['BTC', 'ETH']);
    expect(q.map((x) => x.id)).toEqual(['crypto:BTC', 'crypto:ETH']);
    const { bars } = await crypto().fetchBars('BTC', '1m', NOW - 5 * 60_000, NOW);
    expect(q[0]!.price).toBe(bars.at(-1)!.close);
    expect(q[0]!.ts).toBe(bars.at(-1)!.ts);
    expect(typeof q[0]!.changePct).toBe('number');
    // unknown codes are skipped
    expect(await crypto().quotes(['NOPE'])).toEqual([]);
  });

  it('stock quotes use the last session bar when the market is closed (Sunday)', async () => {
    const [q] = await stock().quotes(['AAPL']);
    const { bars } = await stock().fetchBars('AAPL', '1m', NOW - 3 * DAY, NOW);
    expect(q!.ts).toBe(bars.at(-1)!.ts);
    expect(nyParts(q!.ts).dow).toBe(5); // Friday post-market
  });
});

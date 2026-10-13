import { describe, expect, it } from 'vitest';
import { CoinbaseProvider } from '../../src/providers/coinbase.js';
import { NotFoundError, ProviderError } from '../../src/errors.js';
import { fakeFetch, fixture, jsonResponse } from './helpers.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');

function make(handler: (url: URL) => Response | Promise<Response>, now: () => number = () => NOW) {
  const f = fakeFetch(handler);
  return { p: new CoinbaseProvider({ fetchImpl: f.impl, now }), calls: f.calls, inits: f.inits };
}

/** Serves candles for the requested window, newest-first, like Coinbase. */
function candleServer(rowFor: (tsSec: number) => number[]) {
  return (url: URL) => {
    const g = Number(url.searchParams.get('granularity'));
    const start = Date.parse(url.searchParams.get('start')!) / 1000;
    const end = Date.parse(url.searchParams.get('end')!) / 1000;
    const out: number[][] = [];
    for (let t = Math.ceil(start / g) * g; t <= end; t += g) out.push(rowFor(t));
    if (out.length > 300) return jsonResponse({ message: 'granularity too small for the requested time range' }, 400);
    return jsonResponse(out.reverse());
  };
}

describe('CoinbaseProvider', () => {
  it('identity; no lookback limit; one request (≤ 300 candles) per queued chunk', () => {
    const { p } = make(() => jsonResponse([]));
    expect(p.id).toBe('coinbase');
    expect(p.assetClass).toBe('crypto');
    const M = 60_000;
    expect(p.limits).toEqual({
      maxLookbackMs: {},
      // 30m is built from 5m candles, so its span is 300 × 5m.
      maxSpanPerRequestMs: { '1m': 300 * M, '5m': 1500 * M, '15m': 4500 * M, '30m': 1500 * M, '1h': 300 * 60 * M, '1D': 300 * 1440 * M },
    });
  });

  it('candles: sorted ascending with ms timestamps and correct column mapping', async () => {
    const rows = fixture<number[][]>('coinbase/candles-btc-3600.json');
    const { p, calls, inits } = make(() => jsonResponse(rows));
    const times = rows.map((r) => r[0]! * 1000);
    const from = Math.min(...times);
    const to = Math.max(...times) + HOUR;
    const res = await p.fetchBars('BTC', '1h', from, to);

    expect(calls).toHaveLength(1);
    const u = calls[0]!;
    expect(u.origin + u.pathname).toBe('https://api.exchange.coinbase.com/products/BTC-USD/candles');
    expect(u.searchParams.get('granularity')).toBe('3600');
    expect(Date.parse(u.searchParams.get('start')!)).toBe(from);
    expect(new Headers(inits[0]?.headers).get('User-Agent')).toBe('altv');

    expect(res.bars).toHaveLength(rows.length);
    for (let i = 1; i < res.bars.length; i++) expect(res.bars[i]!.ts).toBeGreaterThan(res.bars[i - 1]!.ts);
    const newest = rows[0]!; // newest-first input
    const [t, low, high, open, close, volume] = newest;
    expect(res.bars.at(-1)).toEqual({ ts: t! * 1000, open, high, low, close, volume });
  });

  it('pages by 300 × granularity', async () => {
    const from = Date.UTC(2026, 0, 1);
    const to = from + 700 * HOUR;
    const { p, calls } = make(candleServer((t) => [t, 1, 3, 2, 2.5, 10]));
    const res = await p.fetchBars('ETH', '1h', from, to);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.pathname).toBe('/products/ETH-USD/candles');
    expect(res.bars).toHaveLength(700);
    const tss = res.bars.map((b) => b.ts);
    expect(new Set(tss).size).toBe(700);
    expect(tss[0]).toBe(from);
    expect(tss.at(-1)).toBe(to - HOUR);
  });

  it('maps native granularities', async () => {
    const seen: string[] = [];
    const { p } = make((url) => { seen.push(url.searchParams.get('granularity')!); return jsonResponse([]); });
    for (const tf of ['1m', '5m', '15m', '1h', '1D'] as const) await p.fetchBars('BTC', tf, NOW - 2 * HOUR, NOW);
    expect(seen).toEqual(['60', '300', '900', '3600', '86400']);
  });

  it('30m is built from 5m candles resampled on the UTC grid', async () => {
    const from = Date.parse('2026-10-10T10:00:00Z');
    const to = from + HOUR;
    const seen: string[] = [];
    const server = candleServer((t) => {
      const i = (t * 1000 - from) / (5 * MIN); // 0..11
      return [t, 100 + i - 1, 100 + i + 2, 100 + i, 100 + i + 1, 1];
    });
    const { p } = make((url) => { seen.push(url.searchParams.get('granularity')!); return server(url); });
    const res = await p.fetchBars('BTC', '30m', from, to);
    expect(new Set(seen)).toEqual(new Set(['300']));
    expect(res.bars).toEqual([
      { ts: from, open: 100, high: 107, low: 99, close: 106, volume: 6 },
      { ts: from + 30 * MIN, open: 106, high: 113, low: 105, close: 112, volume: 6 },
    ]);
    for (const b of res.bars) {
      expect(new Date(b.ts).getUTCMinutes() % 30).toBe(0);
      expect('session' in b).toBe(false);
    }
  });

  it('search: USD, online, tradable products only; prefix before contains', async () => {
    const { p, calls } = make(() => jsonResponse(fixture('coinbase/products.json')));
    const btc = await p.search('btc');
    expect(calls[0]!.pathname).toBe('/products');
    expect(btc).toEqual([{ id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'BTC/USD', exchange: 'Coinbase', pricePrecision: 2 }]);
    expect((await p.search('e')).map((r) => r.id)).toEqual(['crypto:ETH']); // ETH-BTC / BTC-EUR excluded
    expect((await p.search('t')).map((r) => r.id)).toEqual(['crypto:BTC', 'crypto:ETH']);
    expect(calls).toHaveLength(1); // cached
  });

  it('search puts an exact ticker match first', async () => {
    const mk = (b: string) => ({ id: `${b}-USD`, base_currency: b, quote_currency: 'USD', status: 'online', trading_disabled: false, quote_increment: '0.01' });
    const { p } = make(() => jsonResponse([mk('ETHFI'), mk('ETH'), mk('SETH')]));
    expect((await p.search('eth')).map((r) => r.id)).toEqual(['crypto:ETH', 'crypto:ETHFI', 'crypto:SETH']);
  });

  it('search excludes offline and trading-disabled products', async () => {
    const products = [
      { id: 'AAA-USD', base_currency: 'AAA', quote_currency: 'USD', status: 'delisted', trading_disabled: false, quote_increment: '0.01' },
      { id: 'AAB-USD', base_currency: 'AAB', quote_currency: 'USD', status: 'online', trading_disabled: true, quote_increment: '0.01' },
      { id: 'AAC-USD', base_currency: 'AAC', quote_currency: 'USD', status: 'online', trading_disabled: false, quote_increment: '0.0001' },
    ];
    const { p } = make(() => jsonResponse(products));
    expect(await p.search('aa')).toEqual([{ id: 'crypto:AAC', assetClass: 'crypto', ticker: 'AAC', name: 'AAC/USD', exchange: 'Coinbase', pricePrecision: 4 }]);
  });

  // Candles recorded live (granularity 86400, newest first); last = stats.last. Day = 2026-10-13 UTC.
  const QNOW = Date.parse('2026-10-13T06:50:00Z');
  const mk = (h: (url: URL) => Response | Promise<Response>) => make(h, () => QNOW);
  const candles = () => fixture<number[][]>('coinbase/candles-btc-86400.json');
  const quoteHandler = (stats: unknown) => (url: URL) =>
    url.pathname.endsWith('/candles') ? jsonResponse(candles()) : jsonResponse(stats);

  it('quotes: price from /stats last, changePct vs the previous daily candle close', async () => {
    const stats = fixture('coinbase/stats-btc.json');
    const { p, calls } = mk(quoteHandler(stats));
    const res = await p.quotes(['BTC', 'ETH']);
    expect(calls.map((c) => c.pathname)).toEqual([
      '/products/BTC-USD/stats', '/products/BTC-USD/candles', '/products/ETH-USD/stats', '/products/ETH-USD/candles',
    ]);
    expect(calls[1]!.searchParams.get('granularity')).toBe('86400');
    const last = +stats.last;
    const prevClose = candles()[1]![4]!;
    expect(prevClose).toBe(81742.5);
    expect(res[0]).toEqual({ id: 'crypto:BTC', price: last, changePct: ((last / prevClose) - 1) * 100, ts: QNOW });
    expect(res[0]!.changePct).not.toBeCloseTo(((last - +stats.open) / +stats.open) * 100, 2); // not the rolling 24h open
    expect(res[1]!.id).toBe('crypto:ETH');
  });

  it('quotes: uses the latest candle before the current UTC day when today has no candle yet', async () => {
    const stats = fixture('coinbase/stats-btc.json');
    const rows = candles().slice(1); // drop today's candle
    const { p } = mk((url) => (url.pathname.endsWith('/candles') ? jsonResponse(rows) : jsonResponse(stats)));
    const [q] = await p.quotes(['BTC']);
    expect(q!.changePct).toBeCloseTo(((+stats.last / 81742.5) - 1) * 100, 9);
  });

  it('quotes: null changePct when no previous daily candle exists', async () => {
    const stats = fixture('coinbase/stats-btc.json');
    const { p } = mk((url) => (url.pathname.endsWith('/candles') ? jsonResponse([]) : jsonResponse(stats)));
    expect((await p.quotes(['BTC']))[0]!.changePct).toBeNull();
  });

  it('quotes skip per-code 404s and non-finite prices instead of aborting', async () => {
    const stats = fixture('coinbase/stats-btc.json');
    const { p } = mk((url) => {
      if (url.pathname === '/products/NOPE-USD/stats') return jsonResponse({ message: 'NotFound' }, 404);
      if (url.pathname === '/products/BAD-USD/stats') return jsonResponse({ open: '1', last: '' });
      return quoteHandler(stats)(url);
    });
    const res = await p.quotes(['NOPE', 'BTC', 'BAD', 'ETH']);
    expect(res.map((q) => q.id)).toEqual(['crypto:BTC', 'crypto:ETH']);
  });

  it('quotes still propagate retryable failures', async () => {
    const err = await make(() => jsonResponse({ message: 'slow down' }, 429)).p.quotes(['BTC']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('404 → NotFoundError; 429 → retryable ProviderError', async () => {
    const nf = make(() => jsonResponse({ message: 'NotFound' }, 404)).p;
    await expect(nf.fetchBars('NOPE', '1h', NOW - HOUR, NOW)).rejects.toBeInstanceOf(NotFoundError);
    const err = await make(() => jsonResponse({ message: 'Public rate limit exceeded' }, 429)).p.fetchBars('BTC', '1h', NOW - HOUR, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).status).toBe(429);
    expect((err as ProviderError).provider).toBe('coinbase');
  });

  it('firstBarTs is unknown (null) without hitting the network', async () => {
    const { p, calls } = make(() => jsonResponse([]));
    expect(await p.firstBarTs('BTC')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

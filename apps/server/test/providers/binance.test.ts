import { describe, expect, it } from 'vitest';
import { BinanceProvider } from '../../src/providers/binance.js';
import { NotFoundError, ProviderError } from '../../src/errors.js';
import { fakeFetch, fixture, jsonResponse } from './helpers.js';

const BASE = 'https://data-api.binance.vision';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');

function make(handler: (url: URL) => Response | Promise<Response>, now: () => number = () => NOW) {
  const f = fakeFetch(handler);
  return { p: new BinanceProvider({ baseUrl: BASE, fetchImpl: f.impl, now }), calls: f.calls, inits: f.inits };
}

const row = (ts: number, c = 100) => [ts, String(c), String(c + 1), String(c - 1), String(c + 0.5), '12.5', ts + HOUR - 1, '0', 1, '0', '0', '0'];

describe('BinanceProvider', () => {
  it('identity; no lookback limit; one request (1000 klines) per queued chunk', () => {
    const { p } = make(() => jsonResponse([]));
    expect(p.id).toBe('binance');
    expect(p.assetClass).toBe('crypto');
    const M = 60_000;
    expect(p.limits).toEqual({
      maxLookbackMs: {},
      maxSpanPerRequestMs: { '1m': 1000 * M, '5m': 5000 * M, '15m': 15000 * M, '30m': 30000 * M, '1h': 1000 * HOUR, '1D': 24000 * HOUR },
    });
  });

  it('parses klines into numeric bars and requests the USDT pair', async () => {
    const rows = fixture<any[][]>('binance/klines-btcusdt-1h.json');
    const { p, calls, inits } = make(() => jsonResponse(rows));
    const from = rows[0]![0] as number;
    const to = (rows.at(-1)![0] as number) + HOUR;
    const res = await p.fetchBars('BTC', '1h', from, to);

    expect(calls).toHaveLength(1);
    const u = calls[0]!;
    expect(u.origin + u.pathname).toBe(`${BASE}/api/v3/klines`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ symbol: 'BTCUSDT', interval: '1h', startTime: String(from), endTime: String(to - 1), limit: '1000' });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);

    expect(res.bars).toHaveLength(50);
    const r0 = rows[0]!;
    expect(res.bars[0]).toEqual({ ts: r0[0], open: +r0[1], high: +r0[2], low: +r0[3], close: +r0[4], volume: +r0[5] });
    for (const b of res.bars) {
      expect(typeof b.open).toBe('number');
      expect(b.session).toBeUndefined();
    }
  });

  it('drops bars with ts ≥ to', async () => {
    const rows = fixture<any[][]>('binance/klines-btcusdt-1h.json');
    const { p } = make(() => jsonResponse(rows));
    const to = rows.at(-1)![0] as number;
    const res = await p.fetchBars('BTC', '1h', rows[0]![0] as number, to);
    expect(res.bars).toHaveLength(49);
    expect(res.bars.at(-1)!.ts).toBeLessThan(to);
  });

  it('maps 1D to interval 1d', async () => {
    const { p, calls } = make(() => jsonResponse([]));
    await p.fetchBars('ETH', '1D', Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
    expect(calls[0]!.searchParams.get('interval')).toBe('1d');
    expect(calls[0]!.searchParams.get('symbol')).toBe('ETHUSDT');
  });

  it('pages forward with a second request when 1000 rows are returned', async () => {
    const from = Date.UTC(2026, 0, 1);
    const to = from + 1200 * HOUR;
    const { p, calls } = make((url) => {
      const start = Number(url.searchParams.get('startTime'));
      const end = Number(url.searchParams.get('endTime'));
      const out: unknown[] = [];
      for (let t = Math.ceil(start / HOUR) * HOUR; t <= end && out.length < 1000; t += HOUR) out.push(row(t));
      return jsonResponse(out);
    });
    const res = await p.fetchBars('BTC', '1h', from, to);
    expect(calls).toHaveLength(2);
    expect(Number(calls[1]!.searchParams.get('startTime'))).toBe(from + 1000 * HOUR) // next grid slot after the last kline;
    expect(res.bars).toHaveLength(1200);
    const tss = res.bars.map((b) => b.ts);
    expect(new Set(tss).size).toBe(1200);
    expect(tss[0]).toBe(from);
    expect(tss.at(-1)).toBe(to - HOUR);
  });

  it('a full page that reaches `to` needs no follow-up request', async () => {
    const from = Date.UTC(2026, 0, 1);
    const to = from + 1000 * HOUR;
    const { p, calls } = make(() => jsonResponse(Array.from({ length: 1000 }, (_, i) => row(from + i * HOUR))));
    const res = await p.fetchBars('BTC', '1h', from, to);
    expect(calls).toHaveLength(1);
    expect(res.bars).toHaveLength(1000);
  });

  it('search "bt" returns crypto:BTC first and excludes non-USDT and BREAK symbols', async () => {
    const info = fixture('binance/exchange-info.json');
    const { p, calls } = make(() => jsonResponse(info));
    const res = await p.search('bt');
    expect(calls[0]!.pathname).toBe('/api/v3/exchangeInfo');
    expect(calls[0]!.searchParams.get('permissions')).toBe('SPOT');
    expect(res[0]).toEqual({ id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'BTC/USD', exchange: 'Binance', pricePrecision: 2 });
    expect(res.map((r) => r.id)).toEqual(['crypto:BTC']);
    expect((await p.search('b')).map((r) => r.id)).toEqual(['crypto:BTC']); // BCC is BREAK
  });

  it('search ranks prefix matches before contains matches', async () => {
    const info = fixture('binance/exchange-info.json');
    const { p } = make(() => jsonResponse(info));
    expect((await p.search('T')).map((r) => r.id)).toEqual(['crypto:BTC', 'crypto:ETH']);
    expect((await p.search('s')).map((r) => r.id)).toEqual(['crypto:SOL']);
    expect((await p.search('h')).map((r) => r.id)).toEqual(['crypto:ETH']);
  });

  it('caches exchangeInfo for one hour', async () => {
    let t = NOW;
    const info = fixture('binance/exchange-info.json');
    const { p, calls } = make(() => jsonResponse(info), () => t);
    await p.search('btc');
    await p.search('eth');
    expect(calls).toHaveLength(1);
    t += HOUR + 1;
    await p.search('btc');
    expect(calls).toHaveLength(2);
  });

  it('pricePrecision derives from tickSize decimals, capped at 8', async () => {
    const info = {
      symbols: [
        { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00000000010' }] },
        { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00010000' }] },
        { symbol: 'BIGUSDT', baseAsset: 'BIG', quoteAsset: 'USDT', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '1.00000000' }] },
      ],
    };
    const { p } = make(() => jsonResponse(info));
    expect((await p.search('pepe'))[0]!.pricePrecision).toBe(8);
    expect((await p.search('xrp'))[0]!.pricePrecision).toBe(4);
    expect((await p.search('big'))[0]!.pricePrecision).toBe(0);
  });

  it('quotes read lastPrice, priceChangePercent and closeTime from ticker/24hr', async () => {
    const tick = fixture<any[]>('binance/ticker-24hr.json');
    const { p, calls } = make(() => jsonResponse(tick));
    const res = await p.quotes(['BTC', 'ETH']);
    expect(calls[0]!.pathname).toBe('/api/v3/ticker/24hr');
    expect(JSON.parse(calls[0]!.searchParams.get('symbols')!)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(res).toEqual([
      { id: 'crypto:BTC', price: +tick[0].lastPrice, changePct: +tick[0].priceChangePercent, ts: tick[0].closeTime },
      { id: 'crypto:ETH', price: +tick[1].lastPrice, changePct: +tick[1].priceChangePercent, ts: tick[1].closeTime },
    ]);
  });

  it('quotes: batch failing with -1121 falls back to per-symbol requests and skips unknown symbols', async () => {
    const tick = fixture<any[]>('binance/ticker-24hr.json');
    const { p, calls } = make((url) => {
      if (url.searchParams.has('symbols')) return jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400);
      const sym = url.searchParams.get('symbol');
      const row = tick.find((t) => t.symbol === sym);
      return row ? jsonResponse(row) : jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400);
    });
    const res = await p.quotes(['BTC', 'NOPE', 'ETH']);
    expect(res.map((q) => q.id)).toEqual(['crypto:BTC', 'crypto:ETH']);
    expect(calls.map((c) => c.searchParams.get('symbol'))).toEqual([null, 'BTCUSDT', 'NOPEUSDT', 'ETHUSDT']);
  });

  it('quotes skip rows whose lastPrice is not a finite number', async () => {
    const tick = fixture<any[]>('binance/ticker-24hr.json');
    const { p } = make(() => jsonResponse([{ ...tick[0], lastPrice: 'abc' }, tick[1]]));
    expect((await p.quotes(['BTC', 'ETH'])).map((q) => q.id)).toEqual(['crypto:ETH']);
  });

  it('quotes([]) makes no request', async () => {
    const { p, calls } = make(() => jsonResponse([]));
    expect(await p.quotes([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('firstBarTs requests the first daily kline from time 0', async () => {
    const { p, calls } = make(() => jsonResponse([row(1502928000000)]));
    expect(await p.firstBarTs('BTC')).toBe(1502928000000);
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ symbol: 'BTCUSDT', interval: '1d', startTime: '0', limit: '1' });
  });

  it('firstBarTs is null when no klines exist', async () => {
    const { p } = make(() => jsonResponse([]));
    expect(await p.firstBarTs('BTC')).toBeNull();
  });

  it('HTTP 429 / 418 → retryable ProviderError carrying the status', async () => {
    for (const status of [429, 418]) {
      const { p } = make(() => jsonResponse({ code: -1003, msg: 'Too many requests' }, status));
      const err = await p.fetchBars('BTC', '1h', NOW - 10 * HOUR, NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).status).toBe(status);
      expect((err as ProviderError).provider).toBe('binance');
    }
  });

  it('invalid symbol (400, code -1121) → NotFoundError', async () => {
    const { p } = make(() => jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400));
    await expect(p.fetchBars('NOPE', '1h', NOW - 10 * HOUR, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(p.firstBarTs('NOPE')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('other 400 → non-retryable ProviderError; 5xx and network failures → retryable', async () => {
    const e400 = await make(() => jsonResponse({ code: -1100, msg: 'Illegal characters' }, 400)).p.quotes(['BTC']).catch((e: unknown) => e);
    expect(e400).toBeInstanceOf(ProviderError);
    expect((e400 as ProviderError).retryable).toBe(false);
    const e503 = await make(() => new Response('down', { status: 503 })).p.quotes(['BTC']).catch((e: unknown) => e);
    expect((e503 as ProviderError).retryable).toBe(true);
    const net = await make(() => { throw new TypeError('fetch failed'); }).p.quotes(['BTC']).catch((e: unknown) => e);
    expect(net).toBeInstanceOf(ProviderError);
    expect((net as ProviderError).retryable).toBe(true);
  });
});

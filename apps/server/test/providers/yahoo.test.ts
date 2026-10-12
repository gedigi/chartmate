import { describe, expect, it } from 'vitest';
import { createYahooClient, YahooProvider, type YahooLike } from '../../src/providers/yahoo.js';
import { NotFoundError, ProviderError } from '../../src/errors.js';
import { fixture } from './helpers.js';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');

interface Call { sym: string; opts: any }

function fakeYahoo(handlers: Partial<{
  chart: (sym: string, opts: any) => any;
  search: (q: string, opts: any) => any;
  quote: (syms: string[], opts?: any) => any;
}>) {
  const chartCalls: Call[] = [];
  const searchCalls: { q: string; opts: any }[] = [];
  const client: YahooLike = {
    async chart(sym, opts) { chartCalls.push({ sym, opts }); if (!handlers.chart) throw new Error('no chart'); return handlers.chart(sym, opts); },
    async search(q, opts) { searchCalls.push({ q, opts }); if (!handlers.search) throw new Error('no search'); return handlers.search(q, opts); },
    async quote(syms, opts) { if (!handlers.quote) throw new Error('no quote'); return handlers.quote(syms, opts); },
  };
  return { client, chartCalls, searchCalls };
}

function provider(client: YahooLike) {
  return new YahooProvider({ client, now: () => NOW });
}

type Window = { start: string; end: string };
function windowsOf(meta: any): { start: number; end: number; session: string }[] {
  const out: { start: number; end: number; session: string }[] = [];
  for (const session of ['pre', 'regular', 'post']) {
    for (const day of meta.tradingPeriods[session] as Window[][]) {
      for (const w of day) out.push({ start: Date.parse(w.start), end: Date.parse(w.end), session });
    }
  }
  return out;
}

describe('YahooProvider', () => {
  it('has the documented limits', () => {
    const p = provider(fakeYahoo({}).client);
    expect(p.id).toBe('yahoo');
    expect(p.assetClass).toBe('stock');
    expect(p.limits.maxLookbackMs).toEqual({ '1m': 29 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 729 * DAY });
    expect(p.limits.maxSpanPerRequestMs).toEqual({ '1m': 7 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 729 * DAY });
  });

  it('intraday: bars sorted, all have session, sessions follow tradingPeriods', async () => {
    const fx = fixture('yahoo/aapl-15m.json');
    const { client, chartCalls } = fakeYahoo({ chart: () => fx });
    const from = Date.parse('2026-10-08T00:00:00Z');
    const to = Date.parse('2026-10-10T04:00:00Z');
    const res = await provider(client).fetchBars('AAPL', '15m', from, to);

    expect(chartCalls).toHaveLength(1);
    expect(chartCalls[0]!.sym).toBe('AAPL');
    expect(chartCalls[0]!.opts).toMatchObject({ interval: '15m', includePrePost: true });
    expect(chartCalls[0]!.opts.period1.getTime()).toBe(from);
    expect(chartCalls[0]!.opts.period2.getTime()).toBe(to);

    expect(res.bars.length).toBeGreaterThan(50);
    for (let i = 1; i < res.bars.length; i++) expect(res.bars[i]!.ts).toBeGreaterThan(res.bars[i - 1]!.ts);
    const windows = windowsOf(fx.meta);
    for (const b of res.bars) {
      expect(b.session).toBeDefined();
      const w = windows.find((x) => b.ts >= x.start && b.ts < x.end);
      expect(w, new Date(b.ts).toISOString()).toBeDefined();
      expect(b.session).toBe(w!.session);
      expect(Number.isFinite(b.open) && Number.isFinite(b.close)).toBe(true);
    }
    const sessions = new Set(res.bars.map((b) => b.session));
    expect(sessions).toEqual(new Set(['pre', 'regular', 'post']));
    expect(res.sessionWindows).toHaveLength(windows.length);
    expect(res.firstTs).toBe(Date.UTC(1980, 11, 12));
  });

  it('intraday: drops Yahoo\'s off-grid trailing "live tick" bar', async () => {
    const fx = fixture('yahoo/aapl-15m.json');
    const { client } = fakeYahoo({ chart: () => fx });
    const res = await provider(client).fetchBars('AAPL', '15m', Date.parse('2026-10-08T00:00:00Z'), Date.parse('2026-10-10T04:00:00Z'));
    for (const b of res.bars) expect(b.ts % (15 * MIN)).toBe(0);
    expect(res.bars.at(-1)!.ts).toBe(Date.parse('2026-10-09T23:45:00Z'));
  });

  it('half-day: bar after the 13:00 early close (18:15Z) is tagged post', async () => {
    const fx = fixture('yahoo/halfday-15m.json');
    const { client } = fakeYahoo({ chart: () => fx });
    const p = new YahooProvider({ client, now: () => Date.parse('2026-11-28T12:00:00Z') });
    const res = await p.fetchBars('AAPL', '15m', Date.parse('2026-11-27T00:00:00Z'), Date.parse('2026-11-28T00:00:00Z'));
    const byTs = new Map(res.bars.map((b) => [new Date(b.ts).toISOString(), b.session]));
    expect(byTs.get('2026-11-27T17:45:00.000Z')).toBe('regular');
    expect(byTs.get('2026-11-27T18:15:00.000Z')).toBe('post');
  });

  it('half-day: 18:15Z is post even when Yahoo\'s post period starts later (gap after the 18:00Z close)', async () => {
    const fx = fixture('yahoo/halfday-15m.json');
    fx.meta.tradingPeriods.post = [[{ timezone: 'EST', start: '2026-11-27T21:00:00.000Z', end: '2026-11-28T01:00:00.000Z', gmtoffset: -18000 }]];
    fx.meta.tradingPeriods.pre = [[{ timezone: 'EST', start: '2026-11-27T13:00:00.000Z', end: '2026-11-27T14:30:00.000Z', gmtoffset: -18000 }]];
    fx.quotes.push({ date: '2026-11-27T10:00:00.000Z', open: 229, high: 229.5, low: 228.5, close: 229.2, volume: 100 });
    const { client } = fakeYahoo({ chart: () => fx });
    const p = new YahooProvider({ client, now: () => Date.parse('2026-11-28T12:00:00Z') });
    const res = await p.fetchBars('AAPL', '15m', Date.parse('2026-11-27T00:00:00Z'), Date.parse('2026-11-28T00:00:00Z'));
    const byTs = new Map(res.bars.map((b) => [new Date(b.ts).toISOString(), b.session]));
    expect(byTs.get('2026-11-27T18:15:00.000Z')).toBe('post');
    expect(byTs.get('2026-11-27T17:45:00.000Z')).toBe('regular');
    expect(byTs.get('2026-11-27T10:00:00.000Z')).toBe('pre'); // 05:00 EST, before Yahoo's own pre start
    // windows are derived from the regular window: pre from 04:00 NY, post until 20:00 NY
    expect(res.sessionWindows).toEqual([
      { start: Date.parse('2026-11-27T09:00:00Z'), end: Date.parse('2026-11-27T14:30:00Z'), session: 'pre' },
      { start: Date.parse('2026-11-27T14:30:00Z'), end: Date.parse('2026-11-27T18:00:00Z'), session: 'regular' },
      { start: Date.parse('2026-11-27T18:00:00Z'), end: Date.parse('2026-11-28T01:00:00Z'), session: 'post' },
    ]);
  });

  it('derived windows are DST-aware (EDT day: pre from 08:00Z, post until 00:00Z)', async () => {
    const fx = fixture('yahoo/aapl-15m.json');
    const { client } = fakeYahoo({ chart: () => fx });
    const res = await provider(client).fetchBars('AAPL', '15m', Date.parse('2026-10-08T00:00:00Z'), Date.parse('2026-10-10T04:00:00Z'));
    expect(res.sessionWindows!.filter((w) => w.start >= Date.parse('2026-10-09T00:00:00Z'))).toEqual([
      { start: Date.parse('2026-10-09T08:00:00Z'), end: Date.parse('2026-10-09T13:30:00Z'), session: 'pre' },
      { start: Date.parse('2026-10-09T13:30:00Z'), end: Date.parse('2026-10-09T20:00:00Z'), session: 'regular' },
      { start: Date.parse('2026-10-09T20:00:00Z'), end: Date.parse('2026-10-10T00:00:00Z'), session: 'post' },
    ]);
  });

  it('days without a regular window fall back to fixed hours', async () => {
    const fx = fixture('yahoo/halfday-15m.json');
    fx.meta.tradingPeriods = { pre: [[{ start: '2026-11-27T09:00:00.000Z', end: '2026-11-27T14:30:00.000Z' }]], regular: [], post: [] };
    const { client } = fakeYahoo({ chart: () => fx });
    const p = new YahooProvider({ client, now: () => Date.parse('2026-11-28T12:00:00Z') });
    const res = await p.fetchBars('AAPL', '15m', Date.parse('2026-11-27T00:00:00Z'), Date.parse('2026-11-28T00:00:00Z'));
    expect(res.sessionWindows).toBeUndefined();
    expect(res.bars.find((b) => b.ts === Date.parse('2026-11-27T18:15:00Z'))!.session).toBe('regular');
  });

  it('drops an off-grid pseudo-bar even when it falls on whole seconds (23:59:00 in a 15m series)', async () => {
    const fx = fixture('yahoo/aapl-15m.json');
    fx.quotes = fx.quotes.filter((q: any) => q.date !== '2026-10-09T23:59:31.000Z');
    fx.quotes.push({ date: '2026-10-09T23:59:00.000Z', open: 336.08, high: 336.08, low: 336.08, close: 336.08, volume: 0 });
    const { client } = fakeYahoo({ chart: () => fx });
    const res = await provider(client).fetchBars('AAPL', '15m', Date.parse('2026-10-08T00:00:00Z'), Date.parse('2026-10-10T04:00:00Z'));
    expect(res.bars.some((b) => b.ts === Date.parse('2026-10-09T23:59:00Z'))).toBe(false);
    expect(res.bars.at(-1)!.ts).toBe(Date.parse('2026-10-09T23:45:00Z'));
  });

  it('1h: bars stamped at 09:30 NY (13:30Z) are kept', async () => {
    const q = (date: string) => ({ date, open: 100, high: 101, low: 99, close: 100.5, volume: 10 });
    const { client } = fakeYahoo({ chart: () => ({ meta: {}, quotes: [q('2026-10-09T13:30:00.000Z'), q('2026-10-09T14:30:00.000Z'), q('2026-10-09T19:59:00.000Z')] }) });
    const res = await provider(client).fetchBars('SPY', '1h', Date.parse('2026-10-09T00:00:00Z'), Date.parse('2026-10-10T00:00:00Z'));
    expect(res.bars.map((b) => new Date(b.ts).toISOString())).toEqual(['2026-10-09T13:30:00.000Z', '2026-10-09T14:30:00.000Z']);
  });

  it('intraday without tradingPeriods falls back to fixed-hours tagging', async () => {
    const fx = fixture('yahoo/halfday-15m.json');
    delete fx.meta.tradingPeriods;
    const { client } = fakeYahoo({ chart: () => fx });
    const p = new YahooProvider({ client, now: () => Date.parse('2026-11-28T12:00:00Z') });
    const res = await p.fetchBars('AAPL', '15m', Date.parse('2026-11-27T00:00:00Z'), Date.parse('2026-11-28T00:00:00Z'));
    expect(res.sessionWindows).toBeUndefined();
    // 18:15Z = 13:15 EST: regular by fixed hours
    expect(res.bars.find((b) => b.ts === Date.parse('2026-11-27T18:15:00Z'))!.session).toBe('regular');
  });

  it('drops quotes with null/NaN OHLC and defaults null volume to 0', async () => {
    const fx = fixture('yahoo/halfday-15m.json');
    fx.quotes[0].open = null;
    fx.quotes[1].volume = null;
    const { client } = fakeYahoo({ chart: () => fx });
    const p = new YahooProvider({ client, now: () => Date.parse('2026-11-28T12:00:00Z') });
    const res = await p.fetchBars('AAPL', '15m', Date.parse('2026-11-27T00:00:00Z'), Date.parse('2026-11-28T00:00:00Z'));
    expect(res.bars.map((b) => new Date(b.ts).toISOString())).toEqual(['2026-11-27T17:45:00.000Z', '2026-11-27T18:15:00.000Z']);
    expect(res.bars[0]!.volume).toBe(0);
  });

  it('daily: ts are UTC midnights of the NY date, no session, dedupe keeps last', async () => {
    const fx = fixture('yahoo/aapl-1d.json');
    const last = fx.quotes.at(-1);
    fx.quotes.push({ ...last, date: '2026-10-09T20:00:00.000Z', close: 999 });
    const { client, chartCalls } = fakeYahoo({ chart: () => fx });
    const from = Date.UTC(2026, 7, 1);
    const to = Date.UTC(2026, 9, 11);
    const res = await provider(client).fetchBars('AAPL', '1D', from, to);

    expect(chartCalls).toHaveLength(1);
    expect(chartCalls[0]!.opts.interval).toBe('1d');
    expect(chartCalls[0]!.opts.includePrePost).toBeUndefined();
    for (const b of res.bars) {
      expect(b.ts % DAY).toBe(0);
      expect(b.session).toBeUndefined();
    }
    const tss = res.bars.map((b) => b.ts);
    expect(new Set(tss).size).toBe(tss.length);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    expect(res.bars.at(-1)!.ts).toBe(Date.UTC(2026, 9, 9));
    expect(res.bars.at(-1)!.close).toBe(999);
    expect(res.sessionWindows).toBeUndefined();
  });

  it('1m: from older than 29 days is clamped (period1 ≥ now − 29d) and `to` is clamped to now', async () => {
    const { client, chartCalls } = fakeYahoo({ chart: () => ({ meta: {}, quotes: [] }) });
    await provider(client).fetchBars('AAPL', '1m', NOW - 60 * DAY, NOW + DAY);
    expect(chartCalls.length).toBeGreaterThan(0);
    for (const c of chartCalls) {
      expect(c.opts.period1.getTime()).toBeGreaterThanOrEqual(NOW - 29 * DAY);
      expect(c.opts.period2.getTime()).toBeLessThanOrEqual(NOW);
    }
  });

  it('returns no bars and makes no call when the range lies entirely beyond lookback', async () => {
    const { client, chartCalls } = fakeYahoo({ chart: () => ({ meta: {}, quotes: [] }) });
    const res = await provider(client).fetchBars('AAPL', '1m', NOW - 90 * DAY, NOW - 60 * DAY);
    expect(res.bars).toEqual([]);
    expect(chartCalls).toHaveLength(0);
  });

  it('1m request spanning 20 days issues 3 chart calls (7-day chunks) and concatenates without duplicates', async () => {
    const from = Date.parse('2026-09-14T14:00:00Z'); // Mon 10:00 EDT
    const to = from + 20 * DAY;
    let n = 0;
    const { client, chartCalls } = fakeYahoo({
      chart: (_sym, opts) => {
        n++;
        const p1 = opts.period1.getTime();
        const p2 = opts.period2.getTime();
        const q = (ts: number, close: number) => ({ date: new Date(ts), open: 100, high: 101, low: 99, close, volume: 10 });
        // includes a bar at period2, which overlaps the next chunk's first bar
        return { meta: {}, quotes: [q(p1, n * 10), q(p1 + MIN, n * 10 + 1), q(p2, n * 10 + 5)] };
      },
    });
    const res = await provider(client).fetchBars('AAPL', '1m', from, to);
    expect(chartCalls).toHaveLength(3);
    const spans = chartCalls.map((c) => [c.opts.period1.getTime(), c.opts.period2.getTime()]);
    expect(spans).toEqual([[from, from + 7 * DAY], [from + 7 * DAY, from + 14 * DAY], [from + 14 * DAY, to]]);
    const tss = res.bars.map((b) => b.ts);
    expect(tss).toEqual([from, from + MIN, from + 7 * DAY, from + 7 * DAY + MIN, from + 14 * DAY, from + 14 * DAY + MIN]);
    // duplicate at the chunk boundary keeps the later (second chunk's) value
    expect(res.bars[2]!.close).toBe(20);
  });

  it('search filters out futures, foreign listings and isYahooFinance:false', async () => {
    const { client, searchCalls } = fakeYahoo({ search: () => fixture('yahoo/search-apple.json') });
    const res = await provider(client).search('apple');
    expect(searchCalls[0]).toEqual({ q: 'apple', opts: { quotesCount: 20, newsCount: 0 } });
    expect(res.map((r) => r.id)).toEqual(['stock:AAPL', 'stock:APLE']);
    expect(res[0]).toEqual({ id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple Inc.', exchange: 'NMS', pricePrecision: 2 });
  });

  it('search keeps ETFs', async () => {
    const { client } = fakeYahoo({
      search: () => ({ quotes: [{ symbol: 'SPY', quoteType: 'ETF', isYahooFinance: true, exchange: 'PCX', longname: 'SPDR S&P 500 ETF Trust' }] }),
    });
    const res = await provider(client).search('spy');
    expect(res).toEqual([{ id: 'stock:SPY', assetClass: 'stock', ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'PCX', pricePrecision: 2 }]);
  });

  it('"No data found" → NotFoundError', async () => {
    const { client } = fakeYahoo({ chart: () => { throw new Error('No data found, symbol may be delisted'); } });
    await expect(provider(client).fetchBars('ZZZZ', '1D', NOW - 10 * DAY, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(provider(client).firstBarTs('ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('HTTP 404 → NotFoundError; 429 and network failures → retryable ProviderError; others → non-retryable', async () => {
    const httpErr = (code: number, msg: string) => Object.assign(new Error(msg), { name: 'HTTPError', code });
    const run = async (err: unknown) => {
      const { client } = fakeYahoo({ chart: () => { throw err; } });
      return provider(client).fetchBars('AAPL', '1D', NOW - 10 * DAY, NOW).catch((e: unknown) => e);
    };
    expect(await run(httpErr(404, 'Not Found'))).toBeInstanceOf(NotFoundError);
    const e429 = await run(httpErr(429, 'Too Many Requests'));
    expect(e429).toBeInstanceOf(ProviderError);
    expect((e429 as ProviderError).retryable).toBe(true);
    expect((e429 as ProviderError).status).toBe(429);
    expect((e429 as ProviderError).provider).toBe('yahoo');
    const net = await run(new TypeError('fetch failed'));
    expect(net).toBeInstanceOf(ProviderError);
    expect((net as ProviderError).retryable).toBe(true);
    const other = await run(new Error('Only 8 days worth of 1m granularity data are allowed to be fetched per request.'));
    expect(other).toBeInstanceOf(ProviderError);
    expect((other as ProviderError).retryable).toBe(false);
  });

  it('a Yahoo timeout (TimeoutError) → retryable ProviderError', async () => {
    const { client } = fakeYahoo({ chart: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
    const err = await provider(client).fetchBars('AAPL', '1D', NOW - 10 * DAY, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('createYahooClient passes a 15 s timeout signal as module fetchOptions on every call', async () => {
    const seen: any[] = [];
    const yf = {
      chart: async (...args: any[]) => { seen.push(args); return {}; },
      search: async (...args: any[]) => { seen.push(args); return {}; },
      quote: async (...args: any[]) => { seen.push(args); return []; },
    };
    const c = createYahooClient(yf);
    await c.chart('AAPL', { interval: '1d' });
    await c.search('apple', { quotesCount: 20 });
    await c.quote(['AAPL']);
    expect(seen.map((a) => a.slice(0, 2))).toEqual([['AAPL', { interval: '1d' }], ['apple', { quotesCount: 20 }], [['AAPL'], {}]]);
    for (const a of seen) expect(a[2].fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('quotes skip rows whose price is not finite', async () => {
    const { client } = fakeYahoo({
      quote: () => [
        { symbol: 'AAPL', marketState: 'REGULAR', regularMarketPrice: null, regularMarketTime: new Date(NOW) },
        { symbol: 'SPY', marketState: 'REGULAR', regularMarketPrice: Number.NaN, regularMarketTime: new Date(NOW) },
        { symbol: 'MSFT', marketState: 'REGULAR', regularMarketPrice: 400, regularMarketTime: new Date(NOW) },
      ],
    });
    expect((await provider(client).quotes(['AAPL', 'SPY', 'MSFT'])).map((q) => q.id)).toEqual(['stock:MSFT']);
  });

  it('quotes pick postMarketPrice when marketState is POST, else regularMarketPrice', async () => {
    const fx = fixture<any[]>('yahoo/quote-aapl-spy.json');
    fx[0].marketState = 'POST';
    fx[1].marketState = 'REGULAR';
    let asked: string[] = [];
    const { client } = fakeYahoo({ quote: (syms) => { asked = syms; return fx; } });
    const res = await provider(client).quotes(['AAPL', 'SPY']);
    expect(asked).toEqual(['AAPL', 'SPY']);
    expect(res).toEqual([
      { id: 'stock:AAPL', price: fx[0].postMarketPrice, changePct: fx[0].regularMarketChangePercent, ts: Date.parse(fx[0].regularMarketTime) },
      { id: 'stock:SPY', price: fx[1].regularMarketPrice, changePct: fx[1].regularMarketChangePercent, ts: Date.parse(fx[1].regularMarketTime) },
    ]);
    expect(res[0]!.price).not.toBe(fx[0].regularMarketPrice);
  });

  it('quotes pick preMarketPrice when marketState is PRE and present', async () => {
    const { client } = fakeYahoo({
      quote: () => [{ symbol: 'AAPL', marketState: 'PRE', preMarketPrice: 101, regularMarketPrice: 100, regularMarketChangePercent: 1.5, regularMarketTime: new Date(NOW) }],
    });
    expect(await provider(client).quotes(['AAPL'])).toEqual([{ id: 'stock:AAPL', price: 101, changePct: 1.5, ts: NOW }]);
  });

  it('quotes([]) makes no call', async () => {
    const { client } = fakeYahoo({});
    expect(await provider(client).quotes([])).toEqual([]);
  });

  it('firstBarTs reads meta.firstTradeDate from a cheap daily chart call', async () => {
    const { client, chartCalls } = fakeYahoo({ chart: () => fixture('yahoo/aapl-1d.json') });
    expect(await provider(client).firstBarTs('AAPL')).toBe(Date.UTC(1980, 11, 12));
    expect(chartCalls[0]!.opts.interval).toBe('1d');
    expect(chartCalls[0]!.opts.period1.getTime()).toBe(NOW - 7 * DAY);
  });

  it('firstBarTs is null when Yahoo has no firstTradeDate', async () => {
    const { client } = fakeYahoo({ chart: () => ({ meta: {}, quotes: [] }) });
    expect(await provider(client).firstBarTs('AAPL')).toBeNull();
  });

  it('splitsSince requests split events and returns splits strictly after ts', async () => {
    const since = NOW - 30 * DAY;
    const { client, chartCalls } = fakeYahoo({ chart: () => ({
      meta: {}, quotes: [],
      events: { splits: [
        { date: new Date(since - DAY), numerator: 2, denominator: 1, splitRatio: '2:1' },
        { date: new Date(since + 5 * DAY), numerator: 4, denominator: 1, splitRatio: '4:1' },
      ] },
    }) });
    expect(await provider(client).splitsSince('AAPL', since)).toEqual([{ ts: since + 5 * DAY, ratio: '4:1', factor: 4 }]);
    expect(chartCalls[0]!.opts.interval).toBe('3mo');
    expect(chartCalls[0]!.sym).toBe('AAPL');
    expect(chartCalls[0]!.opts.events).toBe('split');
    expect(chartCalls[0]!.opts.period1.getTime()).toBe(since);
    expect(chartCalls[0]!.opts.period2.getTime()).toBe(NOW);
  });

  it('splitsSince: no events → []; errors are mapped like other calls', async () => {
    const { client } = fakeYahoo({ chart: () => ({ meta: {}, quotes: [] }) });
    expect(await provider(client).splitsSince('AAPL', NOW - DAY)).toEqual([]);
    const bad = fakeYahoo({ chart: () => { throw Object.assign(new Error('Too Many Requests'), { code: 429 }); } });
    await expect(provider(bad.client).splitsSince('AAPL', NOW - DAY)).rejects.toBeInstanceOf(ProviderError);
  });
});

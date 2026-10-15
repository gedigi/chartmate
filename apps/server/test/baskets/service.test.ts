import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nyDateUtcMidnight, tagSessionFixedHours, tfMs, type BasketVersion, type NativeTimeframe } from '@chartmate/shared';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { AppError, NotFoundError, ProviderError } from '../../src/errors.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { MarketDataService } from '../../src/market/service.js';
import { BasketService } from '../../src/baskets/service.js';
import { FakeProvider } from '../helpers/fakeProvider.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 8, 1); // Tue 2026-09-01 = day index 0
const NOW = Date.UTC(2026, 9, 9, 12); // Fri 2026-10-09 08:00 EDT
const D = (m: number, d: number, h = 0, min = 0) => Date.UTC(2026, m - 1, d, h, min);
const STOCK_BASE: Record<string, number> = { AAA: 100, BBB: 50, NEW: 100 };
const INTRADAY_NOTICE = 'Basket high/low are approximate (sum of constituent extremes).';

/** stock close = base + dayIndex (AAA base 100, BBB 50); crypto close = 1000 + 10×dayIndex; flat within a day. */
function price(cls: 'stock' | 'crypto') {
  return (code: string, tf: NativeTimeframe, ts: number) => {
    const date = cls === 'stock' && tf !== '1D' ? nyDateUtcMidnight(ts) : Math.floor(ts / DAY) * DAY;
    const d = (date - EPOCH) / DAY;
    const close = cls === 'stock' ? STOCK_BASE[code]! + d : 1000 + 10 * d;
    return { open: close, high: close + 1, low: close - 1, close };
  };
}

const v = (effectiveFrom: string, weights: Record<string, number>): BasketVersion => ({ effectiveFrom, weights });

async function expectAppError(p: Promise<unknown>, status: number, code: string, message?: string | RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  const a = err as AppError;
  expect({ status: a.status, code: a.code }).toEqual({ status, code });
  if (message !== undefined) expect(a.message).toMatch(message);
}

describe('BasketService', () => {
  let h: ReturnType<typeof createDb>;
  let repos: Repos;
  let now: number;
  let stock: FakeProvider;
  let crypto: FakeProvider;
  let market: MarketDataService;
  let svc: BasketService;

  beforeEach(async () => {
    h = createDb('sqlite::memory:');
    await migrate(h.db);
    repos = createRepos(h.db);
    now = NOW;
    const clock = () => now;
    stock = new FakeProvider('stock', clock, undefined, ['AAA', 'BBB', 'NEW']);
    stock.price = price('stock');
    crypto = new FakeProvider('crypto', clock, undefined, ['BTC']);
    crypto.price = price('crypto');
    const queues = {
      stock: new RequestQueue({ concurrency: 2, minIntervalMs: 0, now: clock }),
      crypto: new RequestQueue({ concurrency: 4, minIntervalMs: 0, now: clock }),
    };
    market = new MarketDataService({ repos, registry: { stock, crypto }, now: clock, queues });
    svc = new BasketService({ repos, market, now: clock });
  });
  afterEach(async () => {
    await h.close();
  });

  describe('CRUD + validation', () => {
    it('accepts a valid basket, returns a uuid id, default baseValue 100', async () => {
      const b = await svc.create({ name: '  Mix  ', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      expect(b.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(b.name).toBe('Mix');
      expect(b.baseValue).toBe(100);
      expect(await svc.get(b.id)).toMatchObject({ id: b.id, name: 'Mix', versions: b.versions });
      expect((await svc.list()).map((x) => x.id)).toEqual([b.id]);
    });

    it('rejects bad names and baseValues', async () => {
      const versions = [v('2026-09-14', { 'stock:AAA': 1 })];
      await expectAppError(svc.create({ name: '   ', versions }), 400, 'invalid_basket');
      await expectAppError(svc.create({ name: 'x'.repeat(81), versions }), 400, 'invalid_basket');
      await expectAppError(svc.create({ name: 'ok', baseValue: 0, versions }), 400, 'invalid_basket');
      await expectAppError(svc.create({ name: 'ok', baseValue: Infinity, versions }), 400, 'invalid_basket');
    });

    it('rejects weights that do not sum to 1', async () => {
      await expectAppError(svc.create({ name: 'b', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.4 })] }),
        400, 'invalid_basket', /weights must sum to 1/);
    });

    it('rejects nested baskets', async () => {
      await expectAppError(svc.create({ name: 'b', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'basket:abc': 0.5 })] }),
        400, 'invalid_basket', /no nested baskets/);
    });

    it('rejects unknown symbols (404 from symbolInfo → 400 invalid_basket)', async () => {
      await expectAppError(svc.create({ name: 'b', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:ZZZ': 0.5 })] }),
        400, 'invalid_basket', 'Unknown symbol stock:ZZZ');
    });

    it('rejects a version before the basket start (engine dry-run)', async () => {
      stock.listedFrom.NEW = D(9, 16);
      await expectAppError(svc.create({
        name: 'b',
        versions: [v('2026-09-10', { 'stock:AAA': 0.5, 'stock:NEW': 0.5 }), v('2026-09-15', { 'stock:AAA': 1 })],
      }), 400, 'invalid_basket', 'Version 2 starts before basket start');
    });

    it('returns 503 data_unavailable when the provider is down and no data is cached', async () => {
      crypto.fail = new ProviderError('fixture', '429', true, 429);
      await expectAppError(svc.create({ name: 'b', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] }),
        503, 'data_unavailable', 'Market data temporarily unavailable; try again');
    });

    it('outage on another constituent does not turn a genuine data error into 503 (400 instead)', async () => {
      await market.getNativeBars('crypto:BTC', '1D', D(9, 14) - 10 * DAY, NOW + DAY); // BTC cached
      crypto.fail = new ProviderError('fixture', '429', true, 429); // BTC refresh is stale
      stock.listedFrom.NEW = D(10, 5); // NEW genuinely has no close before 10-01
      await expectAppError(svc.create({
        name: 'b',
        versions: [v('2026-09-14', { 'crypto:BTC': 0.5, 'stock:AAA': 0.5 }), v('2026-10-01', { 'stock:NEW': 0.5, 'stock:AAA': 0.5 })],
      }), 400, 'invalid_basket', /No data for stock:NEW before 2026-10-01/);
    });

    it('503 when the constituent lacking data was itself fetched stale (cached part ends too late)', async () => {
      await market.getNativeBars('stock:NEW', '1D', D(10, 2), NOW + DAY); // only recent NEW bars cached
      stock.fail = new ProviderError('fixture', '429', true, 429);
      await expectAppError(svc.create({
        name: 'b',
        versions: [v('2026-09-14', { 'crypto:BTC': 1 }), v('2026-10-01', { 'stock:NEW': 1 })],
      }), 503, 'data_unavailable');
    });

    it('update / appendVersion / delete; missing ids → NotFoundError', async () => {
      const b = await svc.create({ name: 'b', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      expect((await svc.update(b.id, { name: 'renamed' })).name).toBe('renamed');
      await expectAppError(svc.update(b.id, { versions: [v('2026-09-14', { 'stock:AAA': 2 })] }), 400, 'invalid_basket');
      const u = await svc.update(b.id, { versions: [v('2026-09-14', { 'stock:BBB': 1 })] });
      expect(u.versions).toEqual([v('2026-09-14', { 'stock:BBB': 1 })]);
      const a = await svc.appendVersion(b.id, v('2026-09-21', { 'stock:AAA': 1 }));
      expect(a.versions.map((x) => x.effectiveFrom)).toEqual(['2026-09-14', '2026-09-21']);
      await expectAppError(svc.appendVersion(b.id, v('2026-09-20', { 'stock:AAA': 1 })), 400, 'invalid_basket', /strictly after/);
      await svc.delete(b.id);
      for (const p of [svc.get(b.id), svc.update(b.id, { name: 'x' }), svc.appendVersion(b.id, v('2026-10-01', { 'stock:AAA': 1 })), svc.delete(b.id)]) {
        const err = await p.then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe(`Basket ${b.id} not found`);
      }
      await expectAppError(svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(10, 1) }), 404, 'not_found');
    });
  });

  describe('getBars', () => {
    it('daily bars for a stock+crypto basket equal hand-computed values', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      // Units sized at prior closes: AAA Fri 09-11 (d=10) = 110, BTC Sun 09-13 (d=12) = 1120.
      const all = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 21) });
      // Before the start (09-14) the bars are simulated with the starting holdings.
      expect(all.bars.filter((x) => x.simulated).map((x) => x.ts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((d) => D(9, d)));
      expect(all.notices).toEqual(['Before 2026-09-14: simulated with the starting holdings.']);
      expect(all.markers).toEqual([{ ts: D(9, 14), label: 'Start' }]);
      const r = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 14), to: D(9, 21) });
      expect(r.bars.map((x) => x.ts)).toEqual([14, 15, 16, 17, 18, 19, 20].map((d) => D(9, d)));
      expect(all.bars.slice(-7)).toEqual(r.bars);
      expect(r.bars[0]!.close).toBeCloseTo((50 * 113) / 110 + (50 * 1130) / 1120, 9);
      expect(r.bars[0]!.high).toBeCloseTo((50 * 114) / 110 + (50 * 1131) / 1120, 9);
      expect(r.bars[0]!.low).toBeCloseTo((50 * 112) / 110 + (50 * 1129) / 1120, 9);
      // Saturday: stock flat at Friday's close (d=17), crypto moves (d=18).
      expect(r.bars[5]!.close).toBeCloseTo((50 * 117) / 110 + (50 * 1180) / 1120, 9);
      expect(r).toMatchObject({ stale: false, hasMoreBefore: true, notices: [], markers: [{ ts: D(9, 14), label: 'Start' }] });

      const later = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 16), to: D(9, 21) });
      expect(later.bars[0]!.ts).toBe(D(9, 16));
      expect(later.hasMoreBefore).toBe(true);

      const w = await svc.getBars({ id: b.id, tf: '1W', session: 'rth', from: D(9, 14), to: D(9, 21) });
      expect(w.bars).toHaveLength(1);
      expect(w.bars[0]!.ts).toBe(D(9, 14));
      expect(w.bars[0]!.open).toBeCloseTo((50 * 113) / 110 + (50 * 1130) / 1120, 9);
      expect(w.bars[0]!.close).toBeCloseTo((50 * 117) / 110 + (50 * 1190) / 1120, 9);
    });

    it('appendVersion: v2 marker and continuous close at the switch on RTH 1h', async () => {
      const b = await svc.create({ name: 'two', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      await svc.appendVersion(b.id, v('2026-09-21', { 'stock:AAA': 0.2, 'stock:BBB': 0.8 }));
      const r = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(9, 18), to: D(9, 22) });
      // Stock-only intraday: the switch (and its marker) is at the start of the NY session, 04:00 EDT = 08:00Z.
      expect(r.markers).toEqual([{ ts: D(9, 21, 8), label: 'v2' }]);
      expect(r.notices).toEqual([INTRADAY_NOTICE]);
      expect(r.bars).toHaveLength(14); // 7 RTH bars on Fri + 7 on Mon
      // Level at the switch = v1 units × Fri 09-18 closes (AAA 117, BBB 67); v1 sized at Fri 09-11 (110, 60).
      const L = (50 * 117) / 110 + (50 * 67) / 60;
      const lastBefore = r.bars.find((x) => x.ts === D(9, 18, 19, 30))!;
      const firstAfter = r.bars.find((x) => x.ts === D(9, 21, 13, 30))!;
      expect(lastBefore.close).toBeCloseTo(L, 9);
      // New units sized at the same prior closes → level × weighted price ratio (Mon d=20: AAA 120, BBB 70).
      expect(firstAfter.close).toBeCloseTo(L * (0.2 * (120 / 117) + 0.8 * (70 / 67)), 9);
      expect(r.bars.indexOf(firstAfter)).toBe(r.bars.indexOf(lastBefore) + 1);

      const outside = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(9, 15), to: D(9, 17) });
      expect(outside.markers).toEqual([]);
    });

    it('mixed stock+crypto 1h uses the utc grid: all on the hour, weekends have bars', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(9, 18), to: D(9, 21) });
      expect(r.bars).toHaveLength(72);
      expect(r.bars.every((x) => x.ts % HOUR === 0)).toBe(true);
      const at = (ts: number) => r.bars.find((x) => x.ts === ts)!;
      // Fri 12:00 UTC: before the open, AAA flat at Thu's close (116); BTC Fri (1170).
      expect(at(D(9, 18, 12)).close).toBeCloseTo((50 * 116) / 110 + (50 * 1170) / 1120, 9);
      // Fri 13:00 UTC bucket holds AAA's 13:30 RTH bar (117).
      expect(at(D(9, 18, 13)).close).toBeCloseTo((50 * 117) / 110 + (50 * 1170) / 1120, 9);
      // Saturday: crypto moving, stock flat at Friday's close.
      const sat = r.bars.filter((x) => x.ts >= D(9, 19) && x.ts < D(9, 20));
      expect(sat).toHaveLength(24);
      for (const x of sat) expect(x.close).toBeCloseTo((50 * 117) / 110 + (50 * 1180) / 1120, 9);
      expect(r.notices).toEqual([INTRADAY_NOTICE]);

      // 4h derived from the utc 1h series.
      const r4 = await svc.getBars({ id: b.id, tf: '4h', session: 'rth', from: D(9, 19), to: D(9, 20) });
      expect(r4.bars.map((x) => x.ts)).toEqual([0, 4, 8, 12, 16, 20].map((hh) => D(9, 19, hh)));
    });

    it('backdated T0 before a constituent lists: starts when all have a prior close, notice names it (Review Focus #2)', async () => {
      stock.listedFrom.NEW = D(9, 16); // first bar Wed 09-16
      const b = await svc.create({ name: 'ipo', versions: [v('2026-09-10', { 'stock:AAA': 0.5, 'stock:NEW': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 21) });
      expect(r.notices).toEqual([
        'Basket starts 2026-09-17: stock:NEW has no data before that date.',
        'Before 2026-09-17: simulated with the starting holdings.',
      ]);
      // Simulation starts once every constituent has a value (NEW's first bar 09-16).
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 16), D(9, 17), D(9, 18)]);
      expect(r.bars[0]).toMatchObject({ simulated: true, close: 100 });
      // Sized at Wed 09-16 closes (AAA 115, NEW 115); Thu d=16 → 116.
      expect(r.bars[1]!.close).toBeCloseTo(2 * ((50 * 116) / 115), 9);
      const empty = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 15) });
      expect(empty).toMatchObject({ bars: [], notices: ['Basket starts 2026-09-17: stock:NEW has no data before that date.'] });
    });

    it('stale propagates when the crypto provider fails after caching', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const args = { id: b.id, tf: '1D' as const, session: 'rth' as const, from: D(9, 14), to: NOW + DAY };
      const fresh = await svc.getBars(args);
      expect(fresh.stale).toBe(false);
      crypto.fail = new ProviderError('fixture', '429', true, 429);
      const r = await svc.getBars(args);
      expect(r.stale).toBe(true);
      expect(r.bars).toEqual(fresh.bars);
    });
  });

  describe('getBars: derived timeframes, sessions, version switches', () => {
    it('1W with a mid-week from drops the partial leading bucket', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1W', session: 'rth', from: D(9, 23), to: D(10, 5) });
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 28)]);
      // Week of 09-28 opens Mon 09-28 (AAA d=27 → 127, BTC 1270) and closes Sun 10-04 (AAA Fri 10-02 → 131, BTC d=33 → 1330).
      expect(r.bars[0]!.open).toBeCloseTo((50 * 127) / 110 + (50 * 1270) / 1120, 9);
      expect(r.bars[0]!.close).toBeCloseTo((50 * 131) / 110 + (50 * 1330) / 1120, 9);
    });

    it('1W: the week of a mid-week start mixes simulated and real days (not simulated)', async () => {
      stock.listedFrom.NEW = D(9, 16);
      const b = await svc.create({ name: 'ipo', versions: [v('2026-09-10', { 'stock:AAA': 0.5, 'stock:NEW': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1W', session: 'rth', from: D(9, 1), to: D(9, 28) });
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 14), D(9, 21)]);
      expect(r.bars[0]!.open).toBeCloseTo(100, 9); // Wed 09-16 (simulated, = base value) opens the week
      expect(r.bars[0]!.simulated).toBeUndefined();
      expect(r.bars[0]!.close).toBeCloseTo(2 * ((50 * 117) / 115), 9);
    });

    it('4h with a mid-bucket from drops the partial leading bucket (utc grid)', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '4h', session: 'rth', from: D(9, 19, 2), to: D(9, 20) });
      expect(r.bars.map((x) => x.ts)).toEqual([4, 8, 12, 16, 20].map((hh) => D(9, 19, hh)));
    });

    it('RTH 4h for a stock-only basket uses the nyse-rth grid (13:30Z in EDT)', async () => {
      const b = await svc.create({ name: 'two', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '4h', session: 'rth', from: D(9, 18), to: D(9, 19) });
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 18, 13, 30), D(9, 18, 17, 30)]);
      expect(r.bars[1]!.close).toBeCloseTo((50 * 117) / 110 + (50 * 67) / 60, 9);
    });

    it('ETH 1h for a stock-only basket includes pre/post bars (nyse-eth grid)', async () => {
      const b = await svc.create({ name: 'two', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      const eth = await svc.getBars({ id: b.id, tf: '1h', session: 'eth', from: D(9, 18), to: D(9, 19) });
      // NY 04:30–19:30 EDT = 08:30Z–23:30Z: 16 bars (5 pre, 7 regular, 4 post).
      expect(eth.bars).toHaveLength(16);
      expect(eth.bars[0]!.ts).toBe(D(9, 18, 8, 30));
      expect(eth.bars.at(-1)!.ts).toBe(D(9, 18, 23, 30));
      expect(eth.bars[0]!.close).toBeCloseTo((50 * 117) / 110 + (50 * 67) / 60, 9);
      const rth = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(9, 18), to: D(9, 19) });
      expect(rth.bars).toHaveLength(7);
      const eth4 = await svc.getBars({ id: b.id, tf: '4h', session: 'eth', from: D(9, 18), to: D(9, 19) });
      expect(eth4.bars.map((x) => x.ts)).toEqual([8, 12, 16, 20].map((hh) => D(9, 18, hh))); // anchored 04:00 EDT
    });

    it('stock-only intraday: a version switches at 04:00 NY, not inside the eve\'s winter post-market', async () => {
      now = D(12, 4, 15); // Fri 10:00 EST
      // Post-market prices differ from the regular close (AAA +10), so the units applied to them show.
      stock.price = (code, tf, ts) => {
        const p = price('stock')(code, tf, ts);
        return tf !== '1D' && code === 'AAA' && tagSessionFixedHours(ts) === 'post' ? { ...p, close: p.close + 10 } : p;
      };
      const b = await svc.create({
        name: 'two',
        versions: [v('2026-11-16', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 }), v('2026-12-02', { 'stock:AAA': 0.9, 'stock:BBB': 0.1 })],
      });
      const r = await svc.getBars({ id: b.id, tf: '1h', session: 'eth', from: D(12, 1, 20), to: D(12, 2, 12) });
      expect(r.markers).toEqual([{ ts: D(12, 2, 9), label: 'v2' }]); // 04:00 EST
      const at = (ts: number) => r.bars.find((x) => x.ts === ts)!.close;
      // Tue 12-01 post-market (16:00–20:00 EST = 21:00Z–01:00Z): every bar, before and after 00:00Z, on v1 units.
      const v1 = { AAA: 50 / 173, BBB: 50 / 123 }; // sized at Fri 11-13 (d=73)
      const post = (100 + 91 + 10) * v1.AAA + (50 + 91) * v1.BBB; // d=91
      expect(at(D(12, 1, 23, 30))).toBeCloseTo(post, 9);
      expect(at(D(12, 2, 0, 30))).toBeCloseTo(post, 9);
      // Wed pre-market (d=92) on v2 units sized at Tue's regular close (d=91), level L from v1.
      const L = 191 * v1.AAA + 141 * v1.BBB;
      expect(at(D(12, 2, 9, 30))).toBeCloseTo(L * (0.9 * (192 / 191) + 0.1 * (142 / 141)), 9);
      // Daily bars keep switching at the date (00:00 UTC).
      const d = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(11, 30), to: D(12, 3) });
      expect(d.markers).toEqual([{ ts: D(12, 2), label: 'v2' }]);
    });

    it('mixed baskets keep switching at 00:00 UTC intraday (their UTC grid)', async () => {
      const b = await svc.create({
        name: 'mix',
        versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 }), v('2026-09-21', { 'stock:AAA': 0.2, 'crypto:BTC': 0.8 })],
      });
      const r = await svc.getBars({ id: b.id, tf: '1h', session: 'eth', from: D(9, 20), to: D(9, 22) });
      expect(r.markers).toEqual([{ ts: D(9, 21), label: 'v2' }]);
    });

    it('1M output is stamped on the 1st of the month', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1M', session: 'rth', from: D(9, 1), to: D(11, 1) });
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 1), D(10, 1)]);
      expect(r.bars[0]!.open).toBeCloseTo((50 * 100) / 110 + (50 * 1000) / 1120, 9); // simulated 09-01 opens the month
      expect(r.bars[0]!.close).toBeCloseTo((50 * 129) / 110 + (50 * 1290) / 1120, 9); // Wed 09-30, d=29
    });

    it('two versions with disjoint constituents: stock-only then crypto-only', async () => {
      const b = await svc.create({
        name: 'swap',
        versions: [v('2026-09-14', { 'stock:AAA': 1 }), v('2026-09-21', { 'crypto:BTC': 1 })],
      });
      const r = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 17), to: D(9, 23) });
      // v1 active days need an AAA bar (no weekend bars); v2 trades daily.
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 17), D(9, 18), D(9, 21), D(9, 22)]);
      const L = (100 * 117) / 110; // v1 units × Fri 09-18 close
      expect(r.bars[0]!.close).toBeCloseTo((100 * 116) / 110, 9);
      expect(r.bars[1]!.close).toBeCloseTo(L, 9);
      // v2 sized at BTC's prior close Sun 09-20 (d=19 → 1190).
      expect(r.bars[2]!.close).toBeCloseTo((L * 1200) / 1190, 9);
      expect(r.bars[3]!.close).toBeCloseTo((L * 1210) / 1190, 9);
      expect(r.markers).toEqual([{ ts: D(9, 21), label: 'v2' }]);
    });

    it('a saved basket whose units cannot be computed on read → 503, not 400', async () => {
      const b = await svc.create({ name: 'a', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      await h.db.deleteFrom('bars').execute();
      await h.db.deleteFrom('coverage').execute();
      stock.listedFrom.AAA = Infinity; // provider answers with no data (not an outage)
      const cold = new BasketService({ repos, market, now: () => now });
      await expectAppError(cold.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(10, 1) }),
        503, 'data_unavailable', 'Market data temporarily unavailable; try again');
    });
  });

  describe('units cache', () => {
    it('reuses units; recomputes after 6 h only for versions effective from yesterday on; invalidated by appendVersion', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const spy = vi.spyOn(market, 'getNativeBars');
      const daily = () => spy.mock.calls.filter((c) => c[1] === '1D').length;
      const args = { id: b.id, tf: '1h' as const, session: 'rth' as const, from: NOW - DAY, to: NOW };
      await svc.getBars(args);
      await svc.getBars(args);
      expect(daily()).toBe(0);
      now += 7 * HOUR;
      await svc.getBars(args);
      expect(daily()).toBe(0); // old versions: prior closes are immutable

      await svc.appendVersion(b.id, v('2026-10-09', { 'stock:AAA': 0.3, 'crypto:BTC': 0.7 }));
      spy.mockClear();
      await svc.getBars(args);
      expect(daily()).toBe(0); // fresh from the save-time dry-run
      now += 7 * HOUR;
      await svc.getBars(args);
      expect(daily()).toBe(2); // recent version + older than 6 h → recompute
    });

    it('an outage while refreshing keeps the old units for 5 minutes instead of retrying on every request', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-10-09', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const args = { id: b.id, tf: '1h' as const, session: 'eth' as const, from: NOW - DAY, to: NOW };
      const before = await svc.getBars(args);
      now += 7 * HOUR; // recent version, units older than 6 h: due for a refresh
      crypto.fail = new ProviderError('fixture', '429', true, 429);
      const spy = vi.spyOn(market, 'getNativeBars');
      const daily = () => spy.mock.calls.filter((c) => c[1] === '1D').length;
      const r = await svc.getBars(args);
      expect(r.stale).toBe(true);
      expect(r.bars).toEqual(before.bars);
      expect(daily()).toBe(2);
      await svc.getBars(args);
      expect(daily()).toBe(2); // served from the kept units
      now += 6 * 60_000;
      await svc.getBars(args);
      expect(daily()).toBe(4); // retried after 5 minutes
    });

    it('a version dated tomorrow, sized from today\'s unfinished bar, is resized once that day has closed', async () => {
      // BTC's daily bar for the current UTC day is still moving: its close drifts by +1 per hour until midnight.
      crypto.price = (code, tf, ts) => {
        const p = price('crypto')(code, tf, ts);
        const today = Math.floor(now / DAY) * DAY;
        return tf === '1D' && ts === today ? { ...p, close: p.close + (now - today) / HOUR } : p;
      };
      now = D(10, 9, 22); // Fri 22:00Z
      const b = await svc.create({ name: 'm', versions: [v('2026-09-14', { 'crypto:BTC': 1 })] });
      await svc.appendVersion(b.id, v('2026-10-10', { 'crypto:BTC': 0.5, 'stock:AAA': 0.5 })); // tomorrow
      const spy = vi.spyOn(market, 'getNativeBars');
      const daily = () => spy.mock.calls.filter((c) => c[1] === '1D').length;
      const args = { id: b.id, tf: '1h' as const, session: 'eth' as const, from: D(10, 9, 12), to: D(10, 9, 23) };
      await svc.getBars(args);
      await svc.getBars(args);
      expect(daily()).toBe(0); // provisional units are still cached briefly (no provider call per request)
      now = D(10, 9, 22, 6);
      await svc.getBars(args);
      expect(daily()).toBe(2); // ... for 5 minutes, then re-sized at the bar's latest close
      now = D(10, 10, 1); // 3 h later, past midnight: the 10-09 bar has closed
      const after = { ...args, from: D(10, 10), to: D(10, 10, 1) };
      const fresh = new BasketService({ repos, market, now: () => now });
      const want = await fresh.getBars(after);
      expect(want.bars.length).toBeGreaterThan(0);
      expect((await svc.getBars(after)).bars).toEqual(want.bars);
    });
  });

  describe('units cache + stock splits', () => {
    it('a detected split bumps the market cacheEpoch and the basket recomputes its units', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const args = { id: b.id, tf: '1D' as const, session: 'rth' as const, from: D(9, 20), to: NOW };
      await svc.getBars(args);
      const spy = vi.spyOn(market, 'getNativeBars');
      const unitsFetches = () => spy.mock.calls.filter((c) => c[1] === '1D' && c[2] === D(9, 14) - 10 * DAY).length;
      await svc.getBars(args);
      expect(unitsFetches()).toBe(0);
      stock.splits.AAA = [NOW + HOUR];
      now = NOW + DAY + HOUR;
      await svc.getBars(args);
      expect(unitsFetches()).toBe(2); // both constituents' daily history re-read for the units
      expect(stock.splitsCalls.some((c) => c.code === 'AAA')).toBe(true);
    });
  });

  describe('simulated pre-start history', () => {
    const SIM_NOTICE = 'Before 2026-09-14: simulated with the starting holdings.';

    it('pages back through simulated bars with version 0 units; no duplicates; hasMoreBefore from constituent history', async () => {
      stock.firstTs = D(9, 7);
      stock.listedFrom.AAA = D(9, 7);
      const b = await svc.create({ name: 'a', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      const recent = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 10), to: D(9, 17) });
      expect(recent.bars.map((x) => x.ts)).toEqual([D(9, 10), D(9, 11), D(9, 14), D(9, 15), D(9, 16)]);
      expect(recent.bars.map((x) => x.simulated === true)).toEqual([true, true, false, false, false]);
      // Units sized at Fri 09-11 (d=10 → 110): 100/110 units; Thu 09-10 → 109.
      expect(recent.bars[0]!.close).toBeCloseTo((100 * 109) / 110, 9);
      expect(recent.bars[1]!.close).toBeCloseTo(100, 9); // continuous: S's prior close is the base value
      expect(recent.hasMoreBefore).toBe(true);
      expect(recent.notices).toEqual([SIM_NOTICE]);
      expect(recent.markers).toEqual([{ ts: D(9, 14), label: 'Start' }]);

      const older = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 10) });
      expect(older.bars.map((x) => x.ts)).toEqual([D(9, 7), D(9, 8), D(9, 9)]);
      expect(older.bars.every((x) => x.simulated)).toBe(true);
      expect(older.hasMoreBefore).toBe(false);
      expect(older.markers).toEqual([]);
      const all = [...older.bars, ...recent.bars].map((x) => x.ts);
      expect(new Set(all).size).toBe(all.length);
    });

    it('a basket starting tomorrow is fully simulated up to now (with a Start marker only once S is in range)', async () => {
      const b = await svc.create({ name: 'm', versions: [v('2026-10-10', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(10, 1), to: NOW + DAY });
      expect(r.bars.length).toBeGreaterThan(5);
      expect(r.bars.every((x) => x.simulated)).toBe(true);
      expect(r.notices).toContain('Before 2026-10-10: simulated with the starting holdings.');
      expect(r.markers).toEqual([{ ts: D(10, 10), label: 'Start' }]);
      const latest = await svc.getLatest(b.id, '1h', 'rth');
      expect(latest.bar?.simulated).toBe(true);
    });

    it('unknown constituent history (earliest null): hasMoreBefore follows whether the page had bars', async () => {
      const b = await svc.create({ name: 'a', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      vi.spyOn(market, 'earliest').mockResolvedValue(null);
      const withBars = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 17) });
      expect(withBars.bars.length).toBeGreaterThan(0);
      expect(withBars.hasMoreBefore).toBe(true);
      stock.listedFrom.AAA = D(9, 1);
      await h.db.deleteFrom('bars').execute();
      await h.db.deleteFrom('coverage').execute();
      const empty = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(8, 1), to: D(8, 20) });
      expect(empty.bars).toEqual([]);
      expect(empty.hasMoreBefore).toBe(false); // not forever true
    });

    it('resampled buckets are simulated only when every input bar is', async () => {
      const b = await svc.create({ name: 'm', versions: [v('2026-09-16', { 'crypto:BTC': 1 })] }); // Wed
      const r = await svc.getBars({ id: b.id, tf: '1W', session: 'rth', from: D(9, 7), to: D(9, 21) });
      expect(r.bars.map((x) => [x.ts, x.simulated === true])).toEqual([[D(9, 7), true], [D(9, 14), false]]);
    });

    it('notices an empty window up to now when the basket starts after the last constituent bar', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-10-09', { 'stock:AAA': 1 })] }); // today, before the open
      const r = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(10, 9), to: NOW + HOUR });
      expect(r.bars).toEqual([]);
      expect(r.notices).toContain('Basket starts 2026-10-09; no completed sessions yet.');
      const old = await svc.getBars({ id: b.id, tf: '1h', session: 'rth', from: D(10, 3), to: D(10, 5) }); // weekend page
      expect(old.notices).not.toContain('Basket starts 2026-10-09; no completed sessions yet.');
    });
  });

  describe('live quotes (S13)', () => {
    /** Quote = the constituent's latest daily close at NOW, so the live value must equal getBars' last close. */
    const lastClose = (cls: 'stock' | 'crypto') => (code: string) => price(cls)(code, '1D', D(10, 9)).close;

    it('one batched quotes call per provider class, no getBars per poll, value matches getBars close', async () => {
      const mix = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const stocks = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.4, 'stock:BBB': 0.6 })] });
      stock.quotePrice = lastClose('stock');
      crypto.quotePrice = lastClose('crypto');
      const expected = async (id: string) => {
        const bars = (await svc.getBars({ id, tf: '1D', session: 'rth', from: NOW - 10 * DAY, to: NOW + DAY })).bars;
        return { last: bars.at(-1)!, prev: bars.at(-2)! };
      };
      const em = await expected(mix.id);
      const es = await expected(stocks.id);
      await svc.liveQuotes([mix.id, stocks.id], ['stock:BBB']); // first poll may compute the previous closes
      const spy = vi.spyOn(svc, 'getBars');
      const nativeSpy = vi.spyOn(market, 'getNativeBars');
      stock.quoteCalls = [];
      crypto.quoteCalls = [];
      const r = await svc.liveQuotes([mix.id, stocks.id], ['stock:BBB']);
      expect(spy).not.toHaveBeenCalled();
      expect(nativeSpy).not.toHaveBeenCalled();
      expect(stock.quoteCalls).toHaveLength(1);
      expect([...stock.quoteCalls[0]!].sort()).toEqual(['AAA', 'BBB']);
      expect(crypto.quoteCalls).toEqual([['BTC']]);
      expect(r.market.map((q) => q.id)).toEqual(['stock:BBB']);
      const qm = r.baskets.find((q) => q.id === `basket:${mix.id}`)!;
      const qs = r.baskets.find((q) => q.id === `basket:${stocks.id}`)!;
      expect(qm.price).toBeCloseTo(em.last.close, 9);
      expect(qs.price).toBeCloseTo(es.last.close, 9);
      expect(qm.changePct).toBeCloseTo(((em.last.close - em.prev.close) / em.prev.close) * 100, 9);
      expect(qs.changePct).toBeCloseTo(((es.last.close - es.prev.close) / es.prev.close) * 100, 9);
    });

    it('pre-market Monday: regular pair = Friday close vs Thursday; ext = pre prices vs the basket Friday value', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      now = D(10, 12, 12); // Mon 08:00 EDT, before the open: latest daily bar is Friday 10-09
      // (the fake would already emit a Monday daily bar; Yahoo has none before the open)
      const orig = market.getNativeBars.bind(market);
      vi.spyOn(market, 'getNativeBars').mockImplementation(async (id, tf, from, to) => {
        const r = await orig(id, tf, from, to);
        return tf === '1D' ? { ...r, bars: r.bars.filter((x) => x.ts < D(10, 12)) } : r;
      });
      const bars = (await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: now - 10 * DAY, to: now + DAY })).bars;
      expect(bars.at(-1)!.ts).toBe(D(10, 9));
      // Yahoo in PRE: the regular price is Friday's close (stamped Friday 16:00), the pre print rides in ext.
      stock.quotePrice = lastClose('stock');
      stock.quoteTs = () => D(10, 9, 20);
      const preTs = D(10, 12, 11, 50);
      stock.quoteExt = (c) => (c === 'AAA' ? { session: 'pre', price: 200, changePct: 0, ts: preTs } : undefined); // BBB: no print yet
      const q = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      const last = bars.at(-1)!.close;
      const prev = bars.at(-2)!.close; // Thursday
      expect(q.price).toBeCloseTo(last, 9);
      expect(q.ts).toBe(D(10, 9, 20));
      expect(q.changePct).toBeCloseTo(((last - prev) / prev) * 100, 9);
      const uA = 50 / price('stock')('AAA', '1D', D(9, 11)).close; // sized at the 09-11 close
      const uB = 50 / price('stock')('BBB', '1D', D(9, 11)).close;
      const extValue = uA * 200 + uB * lastClose('stock')('BBB');
      expect(q.ext).toEqual({ session: 'pre', price: expect.any(Number), changePct: expect.any(Number), ts: preTs });
      expect(q.ext!.price).toBeCloseTo(extValue, 9);
      expect(q.ext!.changePct).toBeCloseTo(((extValue - q.price) / q.price) * 100, 9);
    });

    it('post-market Friday evening (already Saturday in UTC): change is vs Thursday; ext = post vs Friday value', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      now = D(10, 10, 0, 30); // Fri 20:30 EDT = Sat 00:30Z
      const bars = (await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: now - 10 * DAY, to: now + DAY })).bars;
      expect(bars.at(-1)!.ts).toBe(D(10, 9));
      stock.quotePrice = () => 200;
      stock.quoteTs = () => D(10, 9, 20); // regularMarketTime, Friday 16:00 EDT
      stock.quoteExt = () => ({ session: 'post', price: 210, changePct: 5, ts: D(10, 10, 0, 15) }); // Friday 20:15 EDT
      const q = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      const prev = bars.at(-2)!.close; // Thursday
      expect(q.changePct).toBeCloseTo(((q.price - prev) / prev) * 100, 9);
      expect(q.ext?.session).toBe('post');
      expect(q.ext!.price).toBeCloseTo((q.price * 210) / 200, 9);
      expect(q.ext!.changePct).toBeCloseTo(5, 9);
      expect(q.ext!.ts).toBe(D(10, 10, 0, 15));
    });

    it('stock-only, winter post-market on the eve of a new version (past 00:00 UTC): still the old units', async () => {
      now = D(12, 2, 0, 30); // Tue 12-01 19:30 EST
      const b = await svc.create({
        name: 's',
        versions: [v('2026-11-16', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 }), v('2026-12-02', { 'stock:AAA': 0.9, 'stock:BBB': 0.1 })],
      });
      stock.quotePrice = (c) => (c === 'AAA' ? 191 : 141); // Tue 12-01 regular closes (d=91)
      stock.quoteTs = () => D(12, 1, 21);
      stock.quoteExt = (c) => (c === 'AAA' ? { session: 'post', price: 201, changePct: 0, ts: now } : undefined);
      const q = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      const v1 = { AAA: 50 / 173, BBB: 50 / 123 }; // sized at Fri 11-13 (d=73)
      expect(q.price).toBeCloseTo(191 * v1.AAA + 141 * v1.BBB, 9);
      expect(q.ext!.price).toBeCloseTo(201 * v1.AAA + 141 * v1.BBB, 9);
    });

    it('a constituent quote stamped in the future (e.g. a day-end closeTime) is clamped to now for ts and the day', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      now = D(10, 9, 23); // Fri 23:00Z
      stock.quotePrice = () => 100;
      crypto.quotePrice = () => 1000;
      stock.quoteTs = () => D(10, 9, 20);
      crypto.quoteTs = () => now;
      const sane = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      crypto.quoteTs = () => D(10, 10, 0, 30); // past UTC midnight: would make the quote "Saturday's"
      const q = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      expect(q.ts).toBe(now);
      expect(q.changePct).toBeCloseTo(sane.changePct!, 9);
    });

    it('a stock + crypto basket: crypto counts at its live price in the ext value; no ext without stock ext', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      crypto.quotePrice = () => 1000;
      stock.quotePrice = () => 110;
      const at110 = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      stock.quotePrice = () => 100;
      const q0 = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      expect(q0.ext).toBeUndefined();
      stock.quoteExt = () => ({ session: 'post', price: 110, changePct: 10, ts: NOW });
      const q = (await svc.liveQuotes([b.id], [])).baskets[0]!;
      expect(q.price).toBeCloseTo(q0.price, 9); // the regular value ignores ext
      expect(q.changePct).toBeCloseTo(q0.changePct!, 9);
      expect(q.ext?.session).toBe('post');
      expect(q.ext!.price).toBeCloseTo(at110.price, 9); // AAA at its post price, BTC at its live price
      expect(q.ext!.changePct).toBeCloseTo((at110.price / q0.price - 1) * 100, 9);
    });

    it('falls back to the daily-bars method when a constituent quote is missing', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.4, 'stock:BBB': 0.6 })] });
      stock.quotePrice = (c) => (c === 'BBB' ? undefined : 1);
      const spy = vi.spyOn(svc, 'getBars');
      const r = await svc.liveQuotes([b.id], []);
      const bars = (await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: NOW - 10 * DAY, to: NOW + DAY })).bars;
      expect(spy).toHaveBeenCalled();
      expect(r.baskets[0]!.price).toBeCloseTo(bars.at(-1)!.close, 9);
      expect(r.baskets[0]!.ts).toBe(bars.at(-1)!.ts);
    });

    it('the cached previous close is recomputed after a basket update and on a new day', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      stock.quotePrice = lastClose('stock');
      await svc.liveQuotes([b.id], []);
      const spy = vi.spyOn(svc, 'getBars');
      await svc.liveQuotes([b.id], []);
      expect(spy).toHaveBeenCalledTimes(0);
      await svc.update(b.id, { versions: [v('2026-09-15', { 'stock:AAA': 1 })] });
      await svc.liveQuotes([b.id], []);
      expect(spy).toHaveBeenCalledTimes(1);
      now = NOW + DAY;
      await svc.liveQuotes([b.id], []);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getLatest', () => {
    it('returns the last bar of the current bucket window', async () => {
      const b = await svc.create({ name: 'mix', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      const r = await svc.getLatest(b.id, '1h', 'rth');
      // Last crypto bar 11:00 UTC Fri 10-09 (d=38 → 1380); AAA flat at Thu 10-08 close (d=37 → 137).
      expect(r.bar?.ts).toBe(D(10, 9, 11));
      expect(r.bar?.close).toBeCloseTo((50 * 137) / 110 + (50 * 1380) / 1120, 9);
      expect(r.stale).toBe(false);
      const d = await svc.getLatest(b.id, '1D', 'rth');
      expect(d.bar?.ts).toBe(D(10, 9));
    });

    it('equals the last bar of a full getBars (stock-only and mixed, across a weekend)', async () => {
      const stocks = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      const mixed = await svc.create({ name: 'm', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      let compared = 0;
      // Fri 08:00 EDT; Mon 05:00 EDT (pre-market after a weekend); Mon 11:00 EDT (regular session)
      for (const at of [NOW, D(10, 12, 9), D(10, 12, 15)]) {
        now = at;
        for (const id of [stocks.id, mixed.id]) {
          for (const tf of ['5m', '1h', '4h', '1D'] as const) {
            for (const session of ['rth', 'eth'] as const) {
              const label = `${id === stocks.id ? 'stocks' : 'mixed'} ${tf} ${session} @${new Date(at).toISOString()}`;
              const full = (await svc.getBars({ id, tf, session, from: D(9, 20), to: now + DAY })).bars.at(-1);
              const latest = (await svc.getLatest(id, tf, session)).bar;
              if (latest === null) {
                // Nothing in the current bucket window (e.g. RTH before the open): the last full bar is older.
                expect(full!.ts, label).toBeLessThan(now - tfMs(tf));
              } else {
                expect(latest, label).toEqual(full);
                compared++;
              }
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(30);
    }, 30_000); // 48 getBars+getLatest pairs: slow under a loaded parallel (Postgres) run

    it('1D for a stock-only basket on a weekend: Friday\'s bar, not null', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      for (const at of [D(10, 10, 15), D(10, 11, 15), D(10, 11, 23, 59)]) { // Sat, Sun 11:00 EDT, Sun 19:59 EDT
        now = at;
        const latest = await svc.getLatest(b.id, '1D', 'rth');
        const full = (await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 20), to: now + DAY })).bars.at(-1);
        expect(latest.bar, new Date(at).toISOString()).toEqual(full);
        expect(latest.bar?.ts).toBe(D(10, 9));
      }
    });

    it('falls back to the full pad when a stock constituent has no seed within the small pad', async () => {
      const b = await svc.create({ name: 'm', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'crypto:BTC': 0.5 })] });
      now = D(10, 9, 15); // Fri 11:00 EDT
      const orig = market.getNativeBars.bind(market);
      // AAA has no bars from Mon 10-05 14:00Z until Fri 14:00Z (e.g. a trading halt)
      const spy = vi.spyOn(market, 'getNativeBars').mockImplementation(async (id, tf, from, to) => {
        const r = await orig(id, tf, from, to);
        if (id !== 'stock:AAA' || tf === '1D') return r;
        return { ...r, bars: r.bars.filter((x) => x.ts < D(10, 5, 14) || x.ts >= D(10, 9, 14)) };
      });
      const latest = await svc.getLatest(b.id, '1h', 'eth');
      const froms = spy.mock.calls.filter((c) => c[0] === 'stock:AAA' && c[1] === '1h').map((c) => c[2]);
      expect(froms).toHaveLength(2); // small pad, then the full 5-day pad
      expect(Math.min(...froms)).toBeLessThanOrEqual(D(10, 9, 14) - 5 * DAY);
      const full = (await svc.getBars({ id: b.id, tf: '1h', session: 'eth', from: D(9, 28), to: now + DAY })).bars.at(-1);
      expect(latest.bar).toEqual(full);
    });

    it('off-hours poll with an empty result does not refetch with the full pad (no extra provider traffic)', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 0.5, 'stock:BBB': 0.5 })] });
      now = D(10, 10, 15); // Saturday: nothing in the current 5m bucket window
      const spy = vi.spyOn(market, 'getNativeBars');
      const r = await svc.getLatest(b.id, '5m', 'eth');
      expect(r.bar).toBeNull();
      expect(spy.mock.calls.filter((c) => c[1] === '5m')).toHaveLength(2); // one per constituent, no retry
    });

    it('an unseeded constituent (empty small-pad result) falls back to the full pad', async () => {
      const b = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      now = D(10, 9, 15);
      const orig = market.getNativeBars.bind(market);
      // AAA intraday bars only exist before Mon 10-05 08:00Z (4.3 days back) within the last week
      const spy = vi.spyOn(market, 'getNativeBars').mockImplementation(async (id, tf, from, to) => {
        const r = await orig(id, tf, from, to);
        if (tf === '1D') return r;
        return { ...r, bars: r.bars.filter((x) => x.ts < D(10, 5, 8)) };
      });
      const latest = await svc.getLatest(b.id, '1D', 'eth');
      expect(latest.bar).not.toBeNull();
      spy.mockClear();
      const intraday = await svc.getLatest(b.id, '5m', 'eth');
      expect(spy.mock.calls.filter((c) => c[1] === '5m')).toHaveLength(2);
      expect(intraday.bar).toBeNull(); // nothing in the current bucket window even with the full pad
    });

    it('fetches a small pad: 4 days for stock baskets, 2 bars for crypto-only, intraday', async () => {
      const stocks = await svc.create({ name: 's', versions: [v('2026-09-14', { 'stock:AAA': 1 })] });
      const coins = await svc.create({ name: 'c', versions: [v('2026-09-14', { 'crypto:BTC': 1 })] });
      const spy = vi.spyOn(market, 'getNativeBars');
      await svc.getLatest(stocks.id, '5m', 'eth');
      const sFrom = Math.min(...spy.mock.calls.filter((c) => c[1] === '5m').map((c) => c[2]));
      expect(sFrom).toBeGreaterThanOrEqual(NOW - 4 * DAY - 10 * 60_000);
      spy.mockClear();
      await svc.getLatest(coins.id, '1h', 'eth');
      const cFrom = Math.min(...spy.mock.calls.filter((c) => c[1] === '1h').map((c) => c[2]));
      expect(cFrom).toBeGreaterThanOrEqual(NOW - 4 * HOUR);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nyDateUtcMidnight, tfMs, type BasketVersion, type NativeTimeframe } from '@altv/shared';
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
      expect(r.markers).toEqual([{ ts: D(9, 21), label: 'v2' }]);
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

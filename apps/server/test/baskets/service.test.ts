import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nyDateUtcMidnight, type BasketVersion, type NativeTimeframe } from '@altv/shared';
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
      const r = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 21) });
      expect(r.bars.map((x) => x.ts)).toEqual([14, 15, 16, 17, 18, 19, 20].map((d) => D(9, d)));
      expect(r.bars[0]!.close).toBeCloseTo((50 * 113) / 110 + (50 * 1130) / 1120, 9);
      expect(r.bars[0]!.high).toBeCloseTo((50 * 114) / 110 + (50 * 1131) / 1120, 9);
      expect(r.bars[0]!.low).toBeCloseTo((50 * 112) / 110 + (50 * 1129) / 1120, 9);
      // Saturday: stock flat at Friday's close (d=17), crypto moves (d=18).
      expect(r.bars[5]!.close).toBeCloseTo((50 * 117) / 110 + (50 * 1180) / 1120, 9);
      expect(r).toMatchObject({ stale: false, hasMoreBefore: false, notices: [], markers: [] });

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
      expect(r.notices).toEqual(['Basket starts 2026-09-17: stock:NEW has no data before that date.']);
      expect(r.bars.map((x) => x.ts)).toEqual([D(9, 17), D(9, 18)]);
      // Sized at Wed 09-16 closes (AAA 115, NEW 115); Thu d=16 → 116.
      expect(r.bars[0]!.close).toBeCloseTo(2 * ((50 * 116) / 115), 9);
      expect(r.hasMoreBefore).toBe(false);
      const empty = await svc.getBars({ id: b.id, tf: '1D', session: 'rth', from: D(9, 1), to: D(9, 15) });
      expect(empty).toMatchObject({ bars: [], hasMoreBefore: false });
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
  });
});

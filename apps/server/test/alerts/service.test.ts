import type { Bar, DrawingState, SymbolId } from '@chartmate/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertService, type AlertNotification } from '../../src/alerts/service.js';
import type { BasketService } from '../../src/baskets/service.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import type { MarketDataService } from '../../src/market/service.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 15);

describe('AlertService', () => {
  let h: TestDb;
  let repos: Repos;
  let price: number;
  let notices: AlertNotification[];
  let reads: string[];
  const market = {
    getBars: async (a: { symbol: SymbolId; tf: string; from: number; to: number }) => {
      reads.push(`${a.symbol} ${a.tf}`);
      const bars: Bar[] = [0, 1, 2].map((i) => ({ ts: NOW - (2 - i) * H, open: price, high: price, low: price, close: price, volume: 1 }));
      return { bars, stale: false, hasMoreBefore: false, earliestTs: null, notices: [] };
    },
    symbolInfo: async () => ({ pricePrecision: 1 }),
  } as unknown as MarketDataService;
  const baskets = {
    getBars: async () => ({ bars: [{ ts: NOW, open: price, high: price, low: price, close: price, volume: 0 }], stale: false, hasMoreBefore: false, notices: [], markers: [] }),
    get: async () => ({ name: 'Tech' }),
  } as unknown as BasketService;
  const service = () => new AlertService({ repos, market, baskets, notify: (n) => notices.push(n), now: () => NOW });
  const hline = (value: number, alert: Partial<NonNullable<DrawingState['alert']>> = {}): DrawingState => ({
    name: 'horizontalStraightLine', points: [{ timestamp: NOW - 10 * H, value }], lock: false,
    alert: { id: 'a1', on: true, tf: '1h', session: 'rth', cross: ['up', 'down'], ...alert },
  });

  beforeEach(async () => {
    h = await createTestDb();
    await migrate(h.db);
    repos = createRepos(h.db);
    price = 101;
    notices = [];
    reads = [];
  });
  afterEach(async () => { await h.close(); });

  it('notifies once when the price crosses a line, remembers it across a restart, and re-arms on request', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100)]);
    const s = service();
    await s.check();
    expect(notices).toEqual([]);
    price = 99;
    await s.check();
    expect(notices).toEqual([{ symbol: 'crypto:BTC', title: 'BTC crossed below the horizontal line', body: 'Price 99.0 · horizontal line at 100.0 · 1h' }]);
    price = 101;
    await s.check();
    expect(notices).toHaveLength(1);
    expect(await s.statuses()).toEqual({ a1: { status: 'fired', at: NOW, message: 'crossed below the horizontal line' } });
    // A restart does not repeat it.
    price = 99;
    await service().check();
    expect(notices).toHaveLength(1);
    await s.rearm('a1');
    expect(await s.statuses()).toEqual({});
    await s.check(); // records the side
    price = 101;
    await s.check();
    expect(notices.map((n) => n.title)).toEqual(['BTC crossed below the horizontal line', 'BTC crossed above the horizontal line']);
  });

  it('switched off: not checked, its memory kept; deleted: its memory dropped', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100)]);
    const s = service();
    await s.check();
    price = 99;
    await s.check();
    await repos.drawings.put('crypto:BTC', [hline(100, { on: false })]);
    reads = [];
    await s.check();
    expect(reads).toEqual([]);
    expect(Object.keys(await s.statuses())).toEqual(['a1']);
    await repos.drawings.put('crypto:BTC', []);
    await s.check();
    expect(await s.statuses()).toEqual({});
  });

  it('reads one series per symbol, timeframe and session; baskets go through the basket service', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100), { ...hline(90), alert: { ...hline(90).alert!, id: 'a2' } }]);
    await repos.drawings.put('basket:11111111-1111-4111-8111-111111111111', [{ ...hline(100), alert: { ...hline(100).alert!, id: 'b1' } }]);
    const s = service();
    await s.check();
    expect(reads).toEqual(['crypto:BTC 1h']);
    price = 95;
    await s.check();
    expect(notices.map((n) => n.title).sort()).toEqual(['BTC crossed below the horizontal line', 'Tech crossed below the horizontal line']);
  });

  it('lists every alert (triggered first, with the ticker), switches one off and removes one where it is stored', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100), { name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false }]);
    await repos.drawings.put('stock:AAPL', [{ ...hline(90), alert: { ...hline(90).alert!, id: 'a2' } }]);
    const s = service();
    await s.check();
    price = 99;
    await s.check(); // a1 fires (BTC crossed 100); a2 (90) does not
    const list = await s.list();
    expect(list.map((e) => [e.id, e.ticker, e.name, e.status])).toEqual([['a1', 'BTC', 'horizontalStraightLine', 'fired'], ['a2', 'AAPL', 'horizontalStraightLine', 'armed']]);
    expect(list[0]!.message).toBe('crossed below the horizontal line');
    expect(await s.update('a2', { on: false })).toBe(true);
    expect((await repos.drawings.get('stock:AAPL'))[0]!.alert?.on).toBe(false);
    expect((await s.list()).at(-1)!.id).toBe('a2'); // switched off: last
    expect(await s.update('a1', null)).toBe(true);
    const btc = await repos.drawings.get('crypto:BTC');
    expect(btc).toHaveLength(2); // the drawing stays, without its alert
    expect(btc[0]).not.toHaveProperty('alert');
    expect(await s.update('nope', null)).toBe(false);
  });

  it('stop waits for a round still running, and nothing runs after it (the database closes next)', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100)]);
    let release: () => void = () => {};
    const slow = { ...market, getBars: async (a: never) => { await new Promise<void>((r) => { release = r; }); return market.getBars(a); } } as unknown as MarketDataService;
    const s = new AlertService({ repos, market: slow, baskets, notify: () => {}, now: () => NOW });
    s.start();
    await new Promise((r) => setTimeout(r, 20));
    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // still waiting for the round
    release();
    await stopping;
    expect(Object.keys(await s.statuses())).toEqual(['a1']);
    reads = [];
    await s.check();
    expect(reads).toEqual([]);
  });

  it('a round that fails entirely never rejects (it is tried again next time)', async () => {
    const broken = { ...repos, drawings: { list: async () => { throw new Error('database closed'); } } } as unknown as Repos;
    await expect(new AlertService({ repos: broken, market, baskets, notify: () => {}, now: () => NOW }).check()).resolves.toBeUndefined();
  });

  it('a failing symbol or notifier does not stop the others', async () => {
    await repos.drawings.put('crypto:BTC', [hline(100)]);
    await repos.drawings.put('stock:AAPL', [{ ...hline(100), alert: { ...hline(100).alert!, id: 'a2' } }]);
    const flaky = { ...market, getBars: async (a: { symbol: SymbolId }) => { if (a.symbol === 'stock:AAPL') throw new Error('down'); return market.getBars(a as never); } } as unknown as MarketDataService;
    let calls = 0;
    const s = new AlertService({ repos, market: flaky, baskets, notify: () => { calls++; throw new Error('no notifications'); }, now: () => NOW });
    await s.check();
    price = 99;
    await s.check();
    expect(calls).toBe(1);
    expect((await s.statuses()).a1?.status).toBe('fired');
  });
});

import type { Layout } from '@chartmate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasketService } from '../../src/baskets/service.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import type { MarketDataService } from '../../src/market/service.js';
import { SyncService } from '../../src/sync/service.js';
import { FakeRepo } from '../helpers/fakeSyncRepo.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

const layout = (symbol: string): Layout => ({ symbol: symbol as Layout['symbol'], tf: '1D', session: 'rth', chartType: 'candle', indicators: [] });
const segment = { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: false };

interface Device { h: TestDb; repos: Repos; sync: SyncService }

describe('SyncService', () => {
  let remote: FakeRepo;
  let clock: number;
  const devices: Device[] = [];

  async function device(): Promise<Device> {
    const h = await createTestDb();
    await migrate(h.db);
    const repos = createRepos(h.db);
    const baskets = new BasketService({ repos, market: {} as MarketDataService });
    const sync = new SyncService({ repos, baskets, remote: () => remote.store(), now: () => clock, pushDelayMs: 10 });
    const d = { h, repos, sync };
    devices.push(d);
    return d;
  }

  beforeEach(() => {
    remote = new FakeRepo();
    clock = 1_000;
  });
  afterEach(async () => {
    for (const d of devices.splice(0)) {
      d.sync.stop();
      await d.h.close();
    }
  });

  it('is off until configured; configuring runs a first sync that uploads this device’s data', async () => {
    const a = await device();
    expect(await a.sync.status()).toEqual({ source: null, repo: null, lastSyncAt: null, lastError: null });
    expect(await a.sync.sync('full')).toBeNull();
    await a.repos.layouts.put('default', layout('crypto:BTC'));
    await a.repos.watchlist.replace([{ type: 'symbol', id: 'stock:AAPL' }]);
    const status = await a.sync.configure('me/chartmate-data', 'tok');
    expect(status).toMatchObject({ source: 'app', repo: 'me/chartmate-data', lastError: null });
    expect(Object.keys(remote.docs()).sort()).toEqual(['layout:default', 'watchlist']);
  });

  it('two devices: an edit on one reaches the other at its next full sync', async () => {
    const a = await device();
    const b = await device();
    await a.repos.drawings.put('crypto:BTC', [segment]);
    await a.sync.configure('me/chartmate-data', 'tok');
    expect(await b.sync.configure('me/chartmate-data', 'tok')).toMatchObject({ applied: 1 });
    expect(await b.repos.drawings.get('crypto:BTC')).toEqual([segment]);

    clock = 2_000;
    await b.repos.layouts.put('default', layout('stock:MSFT'));
    expect(await b.sync.sync('full')).toEqual({ applied: 0, pushed: true });
    expect(await a.sync.check()).toEqual({ remoteNewer: true });
    expect(await a.sync.sync('full')).toEqual({ applied: 1, pushed: false });
    expect((await a.repos.layouts.get('default'))?.symbol).toBe('stock:MSFT');
    expect(await a.sync.check()).toEqual({ remoteNewer: false });
  });

  it('a basket deleted on one device is deleted on the other; the other’s caches see it', async () => {
    const a = await device();
    const b = await device();
    const basket = await a.repos.baskets.create({ id: 'b1', name: 'Tech', baseValue: 100, versions: [{ effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } }] });
    await a.sync.configure('me/chartmate-data', 'tok');
    await b.sync.configure('me/chartmate-data', 'tok');
    expect(await b.repos.baskets.get('b1')).toMatchObject({ name: 'Tech', createdAt: basket.createdAt });
    await a.repos.baskets.delete('b1');
    await a.sync.sync('full');
    expect(remote.docs()['basket:b1']).toMatchObject({ deleted: true });
    await b.sync.sync('full');
    expect(await b.repos.baskets.get('b1')).toBeNull();
  });

  it('push mode sends local edits but leaves newer remote data for the next full sync (an open page is never overwritten)', async () => {
    const a = await device();
    const b = await device();
    await a.sync.configure('me/chartmate-data', 'tok');
    await b.sync.configure('me/chartmate-data', 'tok');
    clock = 2_000;
    await b.repos.layouts.put('default', layout('stock:MSFT'));
    await b.sync.sync('full');
    clock = 3_000;
    await a.repos.drawings.put('stock:AAPL', [segment]);
    expect(await a.sync.sync('push')).toEqual({ applied: 0, pushed: true });
    expect(await a.repos.layouts.get('default')).toBeNull(); // not applied while a page may be open
    expect((remote.docs()['layout:default']!.v as Layout).symbol).toBe('stock:MSFT');
    expect(await a.sync.check()).toEqual({ remoteNewer: true });
    await a.sync.sync('full');
    expect((await a.repos.layouts.get('default'))?.symbol).toBe('stock:MSFT');
  });

  it('two devices pushing different edits keep both', async () => {
    const a = await device();
    const b = await device();
    await a.sync.configure('me/chartmate-data', 'tok');
    await b.sync.configure('me/chartmate-data', 'tok');
    await a.repos.layouts.put('default', layout('stock:AAPL'));
    await b.repos.drawings.put('stock:MSFT', [segment]);
    await b.sync.sync('push');
    await a.sync.sync('push');
    expect(Object.keys(remote.docs()).sort()).toEqual(['drawings:stock:MSFT', 'layout:default']);
  });

  it('a write that lost the race (another device wrote in between) re-reads, merges again and keeps both', async () => {
    const a = await device();
    await a.sync.configure('me/chartmate-data', 'tok');
    await a.repos.layouts.put('default', layout('stock:AAPL'));
    remote.beforeWrite = () => {
      remote.file = { text: JSON.stringify({ format: 1, docs: { 'drawings:stock:MSFT': { t: 5, v: [segment] } } }), sha: 'other' };
    };
    expect(await a.sync.sync('push')).toMatchObject({ pushed: true });
    expect(Object.keys(remote.docs()).sort()).toEqual(['drawings:stock:MSFT', 'layout:default']);
  });

  it('pushes local edits on its own a few seconds after them', async () => {
    vi.useFakeTimers();
    try {
      const a = await device();
      await a.sync.configure('me/chartmate-data', 'tok');
      a.sync.start();
      const before = remote.writes;
      await a.repos.layouts.put('default', layout('stock:AAPL'));
      await a.repos.layouts.put('default', layout('stock:MSFT'));
      await vi.advanceTimersByTimeAsync(20);
      await vi.waitFor(() => expect(remote.writes).toBe(before + 1));
      expect((remote.docs()['layout:default']!.v as Layout).symbol).toBe('stock:MSFT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never applies an invalid document from the file, and never overwrites an unreadable file', async () => {
    const a = await device();
    remote.file = { text: JSON.stringify({ format: 1, docs: { 'layout:default': { t: 9, v: { symbol: 'nope' } }, 'evil:key': { t: 9, v: 1 } } }), sha: 'x' };
    await a.sync.configure('me/chartmate-data', 'tok');
    expect(await a.repos.layouts.get('default')).toBeNull();
    remote.file = { text: '{not json', sha: 'y' };
    await expect(a.sync.sync('full')).rejects.toThrow(/not valid JSON/);
    expect(remote.file.text).toBe('{not json');
    expect((await a.sync.status()).lastError).toMatch(/not valid JSON/);
  });

  it('a failed configure saves nothing; disconnect turns sync off', async () => {
    const a = await device();
    remote.file = { text: '{not json', sha: 'x' };
    await expect(a.sync.configure('me/chartmate-data', 'tok')).rejects.toThrow();
    expect((await a.sync.status()).source).toBeNull();
    remote.file = null;
    await a.sync.configure('me/chartmate-data', 'tok');
    await a.sync.disconnect();
    expect(await a.sync.status()).toEqual({ source: null, repo: null, lastSyncAt: null, lastError: null });
    await expect(a.sync.configure('not a repo', 'tok')).rejects.toThrow(/owner\/name/);
  });

  it('stores the token through the host’s cipher when there is one; env settings win and cannot be changed here', async () => {
    const h = await createTestDb();
    await migrate(h.db);
    const repos = createRepos(h.db);
    const baskets = new BasketService({ repos, market: {} as MarketDataService });
    const seen: string[] = [];
    const sync = new SyncService({
      repos, baskets, now: () => clock,
      remote: (t) => { seen.push(t.token); return remote.store(); },
      cipher: { encrypt: (s) => `enc(${s})`, decrypt: (s) => s.slice(4, -1) },
    });
    await sync.configure('me/chartmate-data', 'tok');
    expect(await repos.settings.get('sync_config')).toContain('enc(tok)');
    await sync.sync('full');
    expect(seen).toEqual(['tok', 'tok']);
    const envSync = new SyncService({ repos, baskets, env: { repo: 'me/other', token: 'envtok' }, remote: () => remote.store() });
    expect(await envSync.status()).toMatchObject({ source: 'env', repo: 'me/other' });
    await expect(envSync.configure('me/x', 't')).rejects.toThrow(/set by the server/);
    // A token encrypted elsewhere (a copied database, a reset keychain) is a readable error, never sent as is.
    const noKey = new SyncService({ repos, baskets, now: () => clock, remote: (t) => { seen.push(t.token); return remote.store(); }, cipher: { encrypt: () => { throw new Error('no keychain'); }, decrypt: () => { throw new Error('bad'); } } });
    await expect(noKey.sync('full')).rejects.toThrow(/cannot be read on this device/);
    await expect(new SyncService({ repos, baskets, remote: () => remote.store() }).sync('full')).rejects.toThrow(/cannot be read on this device/);
    expect(seen).toEqual(['tok', 'tok']);
    await sync.disconnect();
    await expect(noKey.configure('me/chartmate-data', 'tok')).rejects.toThrow(/stored securely/);
    await h.close();
  });
});

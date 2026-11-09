import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BasketService } from '../../src/baskets/service.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import type { MarketDataService } from '../../src/market/service.js';
import { SyncService } from '../../src/sync/service.js';
import { FakeAuth, FakeRepo } from '../helpers/fakeSyncRepo.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

describe('SyncService: sign in with GitHub', () => {
  let h: TestDb;
  let repos: Repos;
  let clock: number;
  let auth: FakeAuth;
  let remote: FakeRepo;
  let tokens: string[];
  let sync: SyncService;

  beforeEach(async () => {
    h = await createTestDb();
    await migrate(h.db);
    repos = createRepos(h.db);
    clock = 1_000_000;
    auth = new FakeAuth(() => clock);
    remote = new FakeRepo();
    tokens = [];
    sync = new SyncService({
      repos, baskets: new BasketService({ repos, market: {} as MarketDataService }), now: () => clock, auth,
      remote: (t) => { tokens.push(t.token); return remote.store(); },
      cipher: { encrypt: (s) => `enc(${s})`, decrypt: (s) => s.slice(4, -1) },
    });
  });
  afterEach(async () => { sync.stop(); await h.close(); });

  async function signIn(): Promise<void> {
    await sync.startSignIn();
    clock += 5_000;
  }

  it('device flow: the code, pending until approved (GitHub asked at most once per interval), then the repositories', async () => {
    expect(await sync.startSignIn()).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: clock + 900_000, interval: 5 });
    auth.polls = [{ state: 'pending', interval: 0 }, { state: 'pending', interval: 10 }];
    expect(await sync.pollSignIn()).toEqual({ state: 'pending', interval: 5 }); // too early: GitHub not asked
    expect(auth.polls).toHaveLength(2);
    clock += 5_000;
    expect(await sync.pollSignIn()).toEqual({ state: 'pending', interval: 5 });
    clock += 5_000;
    expect(await sync.pollSignIn()).toEqual({ state: 'pending', interval: 10 }); // slow_down
    clock += 10_000;
    auth.repos = [];
    expect(await sync.pollSignIn()).toEqual({ state: 'ready', account: 'octocat', repos: [], installUrl: 'https://github.com/apps/chartmate-sync/installations/new' });
    auth.repos = [{ repo: 'octocat/chartmate-data', private: true }];
    expect(await sync.pollSignIn()).toMatchObject({ state: 'ready', repos: [{ repo: 'octocat/chartmate-data', private: true }] });
  });

  it('a denied or expired sign-in ends it', async () => {
    await signIn();
    auth.polls = [{ state: 'denied' }];
    expect(await sync.pollSignIn()).toEqual({ state: 'denied' });
    await expect(sync.pollSignIn()).rejects.toThrow(/Start signing in again/);
    await sync.startSignIn();
    clock += 901_000;
    expect(await sync.pollSignIn()).toEqual({ state: 'expired' });
  });

  it('connects to a private repository the app may use; the credentials are stored encrypted, never returned', async () => {
    await signIn();
    auth.polls = [];
    auth.repos = [{ repo: 'octocat/public', private: false }, { repo: 'octocat/chartmate-data', private: true }];
    await sync.pollSignIn();
    await expect(sync.connectSignedIn('octocat/other')).rejects.toThrow(/cannot use that repository/);
    await expect(sync.connectSignedIn('octocat/public')).rejects.toThrow(/private repository/);
    const status = await sync.connectSignedIn('octocat/chartmate-data');
    expect(status).toEqual({ source: 'app', repo: 'octocat/chartmate-data', auth: 'app', account: 'octocat', lastSyncAt: clock, lastError: null, applied: 0 });
    expect(JSON.stringify(status)).not.toContain('ghu_');
    const stored = JSON.parse((await repos.settings.get('sync_config'))!) as { token: string; kind: string };
    expect(stored.kind).toBe('app');
    expect(stored.token).toMatch(/^enc\(/);
    expect(tokens).toEqual(['ghu_1']);
    await expect(sync.connectSignedIn('octocat/chartmate-data')).rejects.toThrow(/Sign in with GitHub first/);
  });

  it('refreshes the token shortly before it expires, keeps the new refresh token at once, and reports a lost sign-in', async () => {
    await signIn();
    auth.polls = [];
    auth.repos = [{ repo: 'octocat/chartmate-data', private: true }];
    await sync.pollSignIn();
    await sync.connectSignedIn('octocat/chartmate-data');
    clock += 3_600_000;
    await sync.sync('full');
    expect(auth.refreshes).toEqual([]);
    clock += 7 * 3_600_000 - 60_000; // under 5 minutes left
    await sync.sync('full');
    expect(auth.refreshes).toEqual(['ghr_1']);
    expect(tokens.at(-1)).toBe('ghu_2');
    expect(await repos.settings.get('sync_config')).toContain('ghr_2');
    clock += 8 * 3_600_000;
    auth.refreshFails = true;
    await expect(sync.sync('full')).rejects.toThrow(/sign in again/);
    expect((await sync.status()).lastError).toMatch(/sign in again/);
  });

  it('a revoked app token reads as signed out', async () => {
    await signIn();
    auth.polls = [];
    auth.repos = [{ repo: 'octocat/chartmate-data', private: true }];
    await sync.pollSignIn();
    await sync.connectSignedIn('octocat/chartmate-data');
    const { SyncRemoteError } = await import('../../src/sync/github.js');
    remote.beforeRead = () => { throw new SyncRemoteError('GitHub refused the token (expired or revoked?)', 401); };
    await expect(sync.sync('full')).rejects.toThrow('GitHub signed this device out; sign in again');
  });
});

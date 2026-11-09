import { afterEach, describe, expect, it } from 'vitest';
import { SyncRemoteError } from '../../src/sync/github.js';
import { FakeAuth, FakeRepo } from '../helpers/fakeSyncRepo.js';
import { makeApp, type TestApp } from './helpers.js';

describe('/api/sync', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('is off at first; PUT turns it on after a first sync, and the token never comes back out', async () => {
    const remote = new FakeRepo();
    t = await makeApp({}, { syncRemote: () => remote.store() });
    const get = () => t!.app.inject({ method: 'GET', url: '/api/sync' });
    expect((await get()).json()).toEqual({ source: null, repo: null, auth: null, account: null, lastSyncAt: null, lastError: null });
    expect((await t.app.inject({ method: 'POST', url: '/api/sync/run' })).json()).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/sync/check' })).json()).toBeNull();

    await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] } });
    const put = await t.app.inject({ method: 'PUT', url: '/api/sync', payload: { repo: 'me/chartmate-data', token: 'github_pat_secret' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ source: 'app', repo: 'me/chartmate-data', lastError: null, applied: 0 });
    expect(put.body).not.toContain('github_pat_secret');
    expect((await get()).body).not.toContain('github_pat_secret');
    expect(Object.keys(remote.docs())).toEqual(['layout:default']);

    expect((await t.app.inject({ method: 'POST', url: '/api/sync/run' })).json()).toEqual({ applied: 0, pushed: false });
    expect((await t.app.inject({ method: 'GET', url: '/api/sync/check' })).json()).toEqual({ remoteNewer: false });

    expect((await t.app.inject({ method: 'DELETE', url: '/api/sync' })).statusCode).toBe(204);
    expect((await get()).json()).toMatchObject({ source: null, repo: null });
  });

  it('a bad repository or a failing first sync is a 400 with a readable message, and nothing is saved', async () => {
    const remote = new FakeRepo();
    t = await makeApp({}, { syncRemote: () => remote.store() });
    const bad = await t.app.inject({ method: 'PUT', url: '/api/sync', payload: { repo: 'nope', token: 't' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'sync_failed', message: expect.stringMatching(/owner\/name/) });
    remote.file = { text: '{broken', sha: 'x' };
    const broken = await t.app.inject({ method: 'PUT', url: '/api/sync', payload: { repo: 'me/chartmate-data', token: 't' } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().message).toMatch(/not valid JSON/);
    expect((await t.app.inject({ method: 'GET', url: '/api/sync' })).json().source).toBeNull();
  });

  it('a failing run is a 502 with the message, kept as the last error', async () => {
    let fail = false;
    const remote = new FakeRepo();
    t = await makeApp({}, {
      syncRemote: () => ({ read: async () => { if (fail) throw new SyncRemoteError('GitHub refused the token (expired or revoked?)', 401); return remote.store().read(); }, write: remote.store().write }),
    });
    await t.app.inject({ method: 'PUT', url: '/api/sync', payload: { repo: 'me/chartmate-data', token: 't' } });
    fail = true;
    const run = await t.app.inject({ method: 'POST', url: '/api/sync/run' });
    expect(run.statusCode).toBe(502);
    expect(run.json()).toMatchObject({ code: 'sync_failed', message: expect.stringMatching(/refused the token/) });
    expect((await t.app.inject({ method: 'GET', url: '/api/sync' })).json().lastError).toMatch(/refused the token/);
  });

  it('env settings win: shown as such, and not changeable through the API', async () => {
    const remote = new FakeRepo();
    t = await makeApp({ sync: { repo: 'me/server-data', token: 'envtok' } }, { syncRemote: () => remote.store() });
    expect((await t.app.inject({ method: 'GET', url: '/api/sync' })).json()).toMatchObject({ source: 'env', repo: 'me/server-data' });
    expect((await t.app.inject({ method: 'PUT', url: '/api/sync', payload: { repo: 'me/x', token: 't' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/sync' })).statusCode).toBe(400);
  });

  it('sign in with GitHub: start, poll until ready with the repositories, connect; no token ever in an answer', async () => {
    const remote = new FakeRepo();
    let clock = 1_000_000;
    const auth = new FakeAuth(() => clock);
    auth.polls = [];
    auth.repos = [{ repo: 'octocat/chartmate-data', private: true }];
    t = await makeApp({}, { syncRemote: () => remote.store(), syncAuth: auth, now: () => clock });
    const connect = () => t!.app.inject({ method: 'PUT', url: '/api/sync/github', payload: { repo: 'octocat/chartmate-data' } });
    expect((await connect()).json()).toMatchObject({ code: 'sync_failed', message: 'Sign in with GitHub first' });
    const start = await t.app.inject({ method: 'POST', url: '/api/sync/github/start' });
    expect(start.json()).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    expect(start.json()).not.toHaveProperty('deviceCode'); // the device code stays on the server
    expect((await t.app.inject({ method: 'POST', url: '/api/sync/github/poll' })).json()).toEqual({ state: 'pending', interval: 5 });
    clock += 5_000;
    const ready = await t.app.inject({ method: 'POST', url: '/api/sync/github/poll' });
    expect(ready.json()).toMatchObject({ state: 'ready', account: 'octocat', repos: [{ repo: 'octocat/chartmate-data', private: true }] });
    const done = await connect();
    expect(done.json()).toMatchObject({ source: 'app', auth: 'app', account: 'octocat', repo: 'octocat/chartmate-data' });
    for (const body of [start.body, ready.body, done.body, (await t.app.inject({ method: 'GET', url: '/api/sync' })).body]) {
      expect(body).not.toMatch(/gh[ur]_/);
    }
  });

  it('needs the login when a password is set', async () => {
    t = await makeApp({ password: 'correct-horse-battery' }, { syncRemote: () => new FakeRepo().store() });
    for (const [method, url] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync'], ['POST', '/api/sync/run'], ['GET', '/api/sync/check'], ['POST', '/api/sync/github/start'], ['POST', '/api/sync/github/poll'], ['PUT', '/api/sync/github']] as const) {
      expect((await t.app.inject({ method, url, payload: method === 'PUT' ? { repo: 'me/x', token: 't' } : undefined })).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

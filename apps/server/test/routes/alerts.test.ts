import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const line = (alert: unknown) => ({ name: 'horizontalStraightLine', points: [{ timestamp: 1, value: 100 }], lock: false, alert });
const ALERT = { id: 'a1', on: true, tf: '1h', session: 'rth', cross: ['up'] };

describe('/api/alerts and alerts on drawings', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('drawings keep their alert; an invalid alert is dropped on its own; old drawings still load', async () => {
    t = await makeApp();
    const put = await t.app.inject({
      method: 'PUT', url: '/api/drawings/crypto:BTC',
      payload: [line(ALERT), line({ ...ALERT, id: 'a2', tf: '7m' }), { name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }], lock: false }],
    });
    expect(put.statusCode).toBe(200);
    const got = (await t.app.inject({ method: 'GET', url: '/api/drawings/crypto:BTC' })).json() as Array<{ alert?: unknown }>;
    expect(got[0]!.alert).toEqual(ALERT);
    expect(got[1]).not.toHaveProperty('alert');
    expect(got).toHaveLength(3);
  });

  it('the web server does not check alerts (supported: false); the desktop app does', async () => {
    t = await makeApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/alerts' })).json()).toEqual({ supported: false, alerts: {}, list: [] });
    expect((await t.app.inject({ method: 'POST', url: '/api/alerts/a1/rearm' })).statusCode).toBe(204);
    await t.close();
    t = await makeApp({}, { alertNotify: () => {} });
    expect((await t.app.inject({ method: 'GET', url: '/api/alerts' })).json()).toMatchObject({ supported: true });
  });

  it('the desktop app lists alerts and switches or removes one; an unknown one is a 404', async () => {
    t = await makeApp({}, { alertNotify: () => {} });
    await t.app.inject({ method: 'PUT', url: '/api/drawings/crypto:BTC', payload: [line(ALERT)] });
    const got = (await t.app.inject({ method: 'GET', url: '/api/alerts' })).json() as { list: Array<Record<string, unknown>> };
    expect(got.list).toEqual([{ id: 'a1', symbol: 'crypto:BTC', ticker: 'BTC', name: 'horizontalStraightLine', alert: ALERT, status: 'armed', at: null, message: null }]);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/alerts/a1', payload: { on: false } })).statusCode).toBe(200);
    expect(((await t.app.inject({ method: 'GET', url: '/api/drawings/crypto:BTC' })).json() as Array<{ alert: { on: boolean } }>)[0]!.alert.on).toBe(false);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/alerts/a1', payload: { on: 'yes' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/alerts/a1' })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/alerts/a1' })).statusCode).toBe(404);
  });

  it('needs the login when a password is set', async () => {
    t = await makeApp({ password: 'correct-horse-battery' }, { alertNotify: () => {} });
    expect((await t.app.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/alerts/a1/rearm' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/alerts/a1', payload: { on: false } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/alerts/a1' })).statusCode).toBe(401);
  });
});

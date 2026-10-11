import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Basket } from '@altv/shared';
import { basketBody, DAY, isoDate, makeApp, type TestApp } from './helpers.js';

describe('basket routes', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  it('rejects invalid weights with invalid_basket', async () => {
    const body = basketBody();
    body.versions[0]!.weights = { 'stock:AAPL': 0.5, 'crypto:BTC': 0.2 };
    const r = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: body });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_basket' });
  });

  it('rejects malformed bodies with invalid_request', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: { name: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_request' });
    const j = await t.app.inject({
      method: 'POST', url: '/api/baskets', headers: { 'content-type': 'application/json' }, payload: '{not json',
    });
    expect(j.statusCode).toBe(400);
    expect(j.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('CRUD round-trip', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() });
    expect(created.statusCode).toBe(201);
    const b = created.json<Basket>();
    expect(b.id).toEqual(expect.any(String));
    expect(b.versions).toHaveLength(1);

    const list = await t.app.inject({ method: 'GET', url: '/api/baskets' });
    expect(list.json<Basket[]>().map((x) => x.id)).toEqual([b.id]);

    const renamed = await t.app.inject({ method: 'PUT', url: `/api/baskets/${b.id}`, payload: { name: 'Renamed' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Basket>().name).toBe('Renamed');

    const v2 = { effectiveFrom: isoDate(Date.now() - 20 * DAY), weights: { 'stock:AAPL': 0.25, 'crypto:BTC': 0.75 } };
    const appended = await t.app.inject({ method: 'POST', url: `/api/baskets/${b.id}/versions`, payload: v2 });
    expect(appended.statusCode).toBe(200);
    expect(appended.json<Basket>().versions).toHaveLength(2);

    const got = await t.app.inject({ method: 'GET', url: `/api/baskets/${b.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<Basket>()).toMatchObject({ name: 'Renamed', versions: [expect.anything(), v2] });

    const del = await t.app.inject({ method: 'DELETE', url: `/api/baskets/${b.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');

    const gone = await t.app.inject({ method: 'GET', url: `/api/baskets/${b.id}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'not_found' });
    const delAgain = await t.app.inject({ method: 'DELETE', url: `/api/baskets/${b.id}` });
    expect(delAgain.statusCode).toBe(404);
  });
});

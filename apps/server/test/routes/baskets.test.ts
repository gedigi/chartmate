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

  it('caps a version at 50 constituents (zod shape check)', async () => {
    const body = basketBody();
    const weights: Record<string, number> = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`stock:S${i}`, 1 / 51]));
    const payload = { ...body, versions: [{ ...body.versions[0]!, weights }] };
    const r = await t.app.inject({ method: 'POST', url: '/api/baskets', payload });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_request' });
    expect(r.json().message).toMatch(/at most 50 constituents/);
  });

  it('rejects effective dates outside 1970-01-01 … today+1 with invalid_basket', async () => {
    const maxDate = isoDate(Math.floor(Date.now() / DAY) * DAY + DAY);
    for (const effectiveFrom of ['1969-12-31', isoDate(Date.now() + 3 * DAY)]) {
      const body = basketBody();
      body.versions[0]!.effectiveFrom = effectiveFrom;
      const r = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: body });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'invalid_basket', message: `Version 1: Effective date must be between 1970-01-01 and ${maxDate}` });
    }
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

  it('PUT versions changes the start date of a single-version basket, with the create bounds', async () => {
    const b = (await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() })).json<Basket>();
    const weights = b.versions[0]!.weights;
    const moved = { effectiveFrom: isoDate(Date.now() - 200 * DAY), weights };
    const r = await t.app.inject({ method: 'PUT', url: `/api/baskets/${b.id}`, payload: { versions: [moved] } });
    expect(r.statusCode).toBe(200);
    expect(r.json<Basket>().versions).toEqual([moved]);
    const maxDate = isoDate(Math.floor(Date.now() / DAY) * DAY + DAY);
    for (const effectiveFrom of ['1969-12-31', isoDate(Date.now() + 3 * DAY)]) {
      const bad = await t.app.inject({ method: 'PUT', url: `/api/baskets/${b.id}`, payload: { versions: [{ effectiveFrom, weights }] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'invalid_basket', message: `Version 1: Effective date must be between 1970-01-01 and ${maxDate}` });
    }
    const empty = await t.app.inject({ method: 'PUT', url: `/api/baskets/${b.id}`, payload: { versions: [] } });
    expect(empty.statusCode).toBe(400);
  });
});

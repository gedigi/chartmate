import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState } from '@chartmate/shared';
import { makeApp, type TestApp } from './helpers.js';

const points = [{ timestamp: 1000, value: 100 }, { timestamp: 2000, value: 110 }];

describe('drawing points', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const putDrawings = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: body as object });
  const getDrawings = async () => (await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json() as DrawingState[];

  it('drops a drawing without points on its own: the rest of the list is still saved', async () => {
    const ok: DrawingState = { name: 'segment', points, lock: false };
    const res = await putDrawings([{ name: 'segment', points: [], lock: false }, ok]);
    expect(res.statusCode).toBe(200);
    expect(await getDrawings()).toEqual([ok]);
  });

  it('still rejects a list with an otherwise invalid drawing', async () => {
    expect((await putDrawings([{ name: 'segment', points: 'x', lock: false }])).statusCode).toBe(400);
    // Only an empty points ARRAY is dropped: other empty values (a string, a missing list) are invalid.
    expect((await putDrawings([{ name: 'segment', points: '', lock: false }])).statusCode).toBe(400);
    expect((await putDrawings([{ name: 'segment', lock: false }])).statusCode).toBe(400);
  });
});

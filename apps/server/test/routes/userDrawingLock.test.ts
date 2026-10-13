import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState } from '@chartmate/shared';
import { makeApp, type TestApp } from './helpers.js';

const points = [{ timestamp: 1000, value: 100 }, { timestamp: 2000, value: 110 }];

describe('per-drawing lock', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const putDrawings = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: body as object });
  const getDrawings = async () => (await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json() as DrawingState[];

  it('round-trips the locked flag of each drawing', async () => {
    const d: DrawingState[] = [
      { name: 'segment', points, lock: true, locked: true },
      { name: 'longPosition', points: [...points, ...points], lock: false, locked: false },
    ];
    expect((await putDrawings(d)).statusCode).toBe(200);
    expect(await getDrawings()).toEqual(d);
  });

  it('accepts drawings saved before the flag existed (no locked: unlocked)', async () => {
    const old = { name: 'segment', points, lock: false };
    expect((await putDrawings([old])).statusCode).toBe(200);
    expect(await getDrawings()).toEqual([old]);
  });

  it('drops an invalid locked flag on its own: the drawing is still saved', async () => {
    expect((await putDrawings([{ name: 'segment', points, lock: false, locked: 'yes' }])).statusCode).toBe(200);
    expect(await getDrawings()).toEqual([{ name: 'segment', points, lock: false }]);
  });
});

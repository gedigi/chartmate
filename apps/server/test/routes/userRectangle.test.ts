import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState } from '@chartmate/shared';
import { makeApp, type TestApp } from './helpers.js';

const corners = [{ timestamp: 1_700_000_000_000, value: 100 }, { timestamp: 1_700_432_000_000, value: 112.5 }];

describe('rectangle drawings', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const put = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: body as object });
  const putRaw = (json: string) => t.app.inject({
    method: 'PUT', url: '/api/drawings/stock:AAPL', payload: json, headers: { 'content-type': 'application/json' },
  });
  const get = async () => (await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json() as DrawingState[];

  it('stores a rectangle with its two corners, palette color, line style and fill option', async () => {
    const rect: DrawingState = {
      name: 'rectangle', points: corners, lock: false, locked: true, anchorTf: '1D',
      styles: { line: { color: 'palette:3', size: 2, style: 'dashed' }, fill: false },
    };
    const sticky: DrawingState = { name: 'rectangle', points: corners, lock: true, styles: { color: 'up' } };
    expect((await put([rect, sticky])).statusCode).toBe(200);
    expect(await get()).toEqual([rect, sticky]);
  });

  it('keeps old drawings next to it, and drops an invalid fill on its own', async () => {
    const old: DrawingState = { name: 'parallelStraightLine', points: [...corners, { timestamp: 1_700_100_000_000, value: 90 }], lock: false };
    const res = await put([old, { name: 'rectangle', points: corners, lock: false, styles: { color: 'accent', fill: 'yes' } }]);
    expect(res.statusCode).toBe(200);
    expect(await get()).toEqual([old, { name: 'rectangle', points: corners, lock: false, styles: { color: 'accent' } }]);
  });

  it('rejects a rectangle without exactly two finite corners', async () => {
    for (const points of [[corners[0]], [...corners, corners[0]], [corners[0], { timestamp: 1, value: 'x' }]]) {
      expect((await put([{ name: 'rectangle', points, lock: false }])).statusCode, JSON.stringify(points)).toBe(400);
    }
    // 1e400 parses to Infinity.
    const inf = '[{"name":"rectangle","points":[{"timestamp":1700000000000,"value":1e400},{"timestamp":1700432000000,"value":1}],"lock":false}]';
    expect((await putRaw(inf)).statusCode).toBe(400);
    expect(await get()).toEqual([]);
  });
});

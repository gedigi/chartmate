import { describe, it, expect } from 'vitest';
import { computeVersionUnits, buildBasketBars } from '../src/basket.js';
import { resample } from '../src/resample.js';

const D = 86_400_000;
const H = 3_600_000;
const day = (s: string) => Date.parse(s + 'T00:00:00Z');
const bar = (ts: number, c: number) => ({ ts, open: c, high: c, low: c, close: c, volume: 0 });
const dailies = (start: string, closes: number[]) => closes.map((c, i) => bar(day(start) + i * D, c));

describe('buildBasketBars simulated pre-start history', () => {
  const daily = {
    'stock:A': dailies('2024-01-01', [10, 20, 20, 40]),
    'crypto:B': dailies('2024-01-01', [100, 100, 50, 50]),
  };
  const both = [{ id: 'stock:A', bars: daily['stock:A'] }, { id: 'crypto:B', bars: daily['crypto:B'] }];

  it('holds version 0 units fixed backwards, flags those bars simulated and is continuous at S', () => {
    const v0 = { effectiveFrom: '2024-01-03', weights: { 'stock:A': 0.5, 'crypto:B': 0.5 } };
    const u = computeVersionUnits([v0], daily, 100);
    // Sized at Jan 2 closes: A 50/20 = 2.5, B 50/100 = 0.5.
    expect(u.versions[0]!.units).toEqual({ 'stock:A': 2.5, 'crypto:B': 0.5 });
    const bars = buildBasketBars(u, both, { simulate: true });
    expect(bars.map((b) => b.ts)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'].map(day));
    expect(bars.map((b) => b.close)).toEqual([2.5 * 10 + 0.5 * 100, 2.5 * 20 + 0.5 * 100, 2.5 * 20 + 0.5 * 50, 2.5 * 40 + 0.5 * 50]);
    expect(bars.map((b) => b.simulated === true)).toEqual([true, true, false, false]);
    expect('simulated' in bars[2]!).toBe(false);
    // The last simulated close (prior close of S) is the base value: continuous by construction.
    expect(bars[1]!.close).toBe(100);
  });

  it('without the option nothing before S is emitted (unchanged behaviour)', () => {
    const v0 = { effectiveFrom: '2024-01-03', weights: { 'stock:A': 0.5, 'crypto:B': 0.5 } };
    const u = computeVersionUnits([v0], daily, 100);
    expect(buildBasketBars(u, both).map((b) => b.ts)).toEqual(['2024-01-03', '2024-01-04'].map(day));
  });

  it('starts only once every version-0 constituent has a value (late listing)', () => {
    const late = { 'stock:A': dailies('2024-01-01', [10, 20, 20, 40]), 'crypto:B': dailies('2024-01-02', [100, 50, 50]) };
    const v0 = { effectiveFrom: '2024-01-04', weights: { 'stock:A': 0.5, 'crypto:B': 0.5 } };
    const u = computeVersionUnits([v0], late, 100);
    const bars = buildBasketBars(u, [{ id: 'stock:A', bars: late['stock:A'] }, { id: 'crypto:B', bars: late['crypto:B'] }], { simulate: true });
    expect(bars[0]!.ts).toBe(day('2024-01-02'));
    expect(bars.filter((b) => b.simulated).map((b) => b.ts)).toEqual(['2024-01-02', '2024-01-03'].map(day));
  });

  it('the simulated part always uses version 0 units', () => {
    const v0 = { effectiveFrom: '2024-01-02', weights: { 'stock:A': 1 } };
    const v1 = { effectiveFrom: '2024-01-04', weights: { 'crypto:B': 1 } };
    const u = computeVersionUnits([v0, v1], daily, 100);
    const bars = buildBasketBars(u, both, { simulate: true });
    expect(bars[0]).toMatchObject({ ts: day('2024-01-01'), close: 100, simulated: true }); // 10 units × 10
    expect(bars.filter((b) => b.simulated)).toHaveLength(1);
  });
});

describe('resample simulated flag', () => {
  const sim = (ts: number, c: number, simulated?: boolean) => ({ ...bar(ts, c), ...(simulated ? { simulated } : {}) });
  it('a bucket is simulated only if all its inputs are', () => {
    const out = resample([sim(0, 1, true), sim(H, 2, true), sim(4 * H, 3, true), sim(5 * H, 4)], '4h', 'utc');
    expect(out.map((b) => b.simulated === true)).toEqual([true, false]);
    expect('simulated' in out[1]!).toBe(false);
    expect('simulated' in resample([sim(0, 1), sim(H, 2)], '4h', 'utc')[0]!).toBe(false);
  });
});

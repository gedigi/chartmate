import { describe, it, expect } from 'vitest';
import { validateVersions, normalizeWeights, computeVersionUnits, buildBasketBars, versionMarkers, BasketValidationError } from '../src/basket.js';
const D = 86_400_000;
const day = (s: string) => Date.parse(s + 'T00:00:00Z');
const bar = (ts: number, c: number, o = c, h = c, l = c) => ({ ts, open: o, high: h, low: l, close: c, volume: 0 });
const dailies = (start: string, closes: number[]) => closes.map((c, i) => bar(day(start) + i * D, c));

describe('validateVersions', () => {
  const ok = { effectiveFrom: '2024-01-02', weights: { 'stock:A': 0.5, 'crypto:B': 0.5 } };
  it('accepts valid', () => expect(() => validateVersions([ok])).not.toThrow());
  it('rejects empty', () => expect(() => validateVersions([])).toThrow(BasketValidationError));
  it('rejects bad sum', () => expect(() => validateVersions([{ ...ok, weights: { 'stock:A': 0.5 } }])).toThrow(BasketValidationError));
  it('rejects non-positive', () => expect(() => validateVersions([{ ...ok, weights: { 'stock:A': 1.5, 'crypto:B': -0.5 } }])).toThrow(BasketValidationError));
  it('rejects nested basket', () => expect(() => validateVersions([{ ...ok, weights: { 'basket:x': 1 } }])).toThrow(BasketValidationError));
  it('rejects non-increasing dates', () => expect(() => validateVersions([ok, { ...ok }])).toThrow(BasketValidationError));
  it('rejects bad date', () => expect(() => validateVersions([{ ...ok, effectiveFrom: '2024-02-31' }])).toThrow(BasketValidationError));
  it('rejects empty weights', () => expect(() => validateVersions([{ ...ok, weights: {} }])).toThrow(BasketValidationError));
  it('rejects non-finite weight', () => expect(() => validateVersions([{ ...ok, weights: { 'stock:A': Infinity } }])).toThrow(BasketValidationError));
  it('rejects empty code and unknown prefix', () => {
    expect(() => validateVersions([{ ...ok, weights: { 'stock:': 1 } }])).toThrow(BasketValidationError);
    expect(() => validateVersions([{ ...ok, weights: { 'fx:EURUSD': 1 } }])).toThrow(BasketValidationError);
  });
  it('accepts increasing multi-version', () =>
    expect(() => validateVersions([ok, { effectiveFrom: '2024-02-01', weights: { 'stock:A': 1 } }])).not.toThrow());
});

describe('normalizeWeights', () => {
  it('scales', () => expect(normalizeWeights({ a: 2, b: 6 })).toEqual({ a: 0.25, b: 0.75 }));
  it('throws on zero', () => expect(() => normalizeWeights({ a: 0 })).toThrow());
});

describe('computeVersionUnits + buildBasketBars', () => {
  const daily = {
    'stock:A': dailies('2024-01-01', [10, 20, 20, 40]),   // Jan 1..4
    'crypto:B': dailies('2024-01-01', [100, 100, 50, 50]),
  };
  const v0 = { effectiveFrom: '2024-01-02', weights: { 'stock:A': 0.5, 'crypto:B': 0.5 } };
  const both = [{ id: 'stock:A', bars: daily['stock:A'] }, { id: 'crypto:B', bars: daily['crypto:B'] }];

  it('single version: sized at prior close, index = Σ units × price', () => {
    const u = computeVersionUnits([v0], daily, 100);
    expect(u.startTs).toBe(day('2024-01-02'));
    expect(u.versions[0]!.units).toEqual({ 'stock:A': 5, 'crypto:B': 0.5 }); // 50/10, 50/100
    const bars = buildBasketBars(u, both);
    expect(bars.map(b => b.close)).toEqual([150, 125, 225]);
    expect(bars[0]!.ts).toBe(day('2024-01-02'));
  });

  it('chained version is continuous at the switch', () => {
    const v1 = { effectiveFrom: '2024-01-04', weights: { 'stock:A': 1 } };
    const u = computeVersionUnits([v0, v1], daily, 100);
    expect(u.versions[1]).toEqual({ effectiveTs: day('2024-01-04'), units: { 'stock:A': 6.25 }, levelAtStart: 125 });
    const bars = buildBasketBars(u, both);
    expect(bars.map(b => b.close)).toEqual([150, 125, 250]);
    expect(versionMarkers(u)).toEqual([{ ts: day('2024-01-04'), label: 'v2' }]);
  });

  it('three versions chain level through each switch', () => {
    const v1 = { effectiveFrom: '2024-01-03', weights: { 'stock:A': 1 } };
    const v2 = { effectiveFrom: '2024-01-04', weights: { 'crypto:B': 0.5, 'stock:A': 0.5 } };
    const u = computeVersionUnits([v0, v1, v2], daily, 100);
    // v1: L = 5*20 + 0.5*100 = 150, A units 150/20 = 7.5
    expect(u.versions[1]!.levelAtStart).toBe(150);
    expect(u.versions[1]!.units).toEqual({ 'stock:A': 7.5 });
    // v2: L = 7.5*20 = 150; A: 75/20=3.75, B: 75/50=1.5
    expect(u.versions[2]!.levelAtStart).toBe(150);
    expect(u.versions[2]!.units).toEqual({ 'stock:A': 3.75, 'crypto:B': 1.5 });
    const bars = buildBasketBars(u, both);
    expect(bars.map(b => b.close)).toEqual([150, 150, 3.75 * 40 + 1.5 * 50]);
    expect(versionMarkers(u).map(m => m.label)).toEqual(['v2', 'v3']);
  });

  it('version switch exactly at a timeline timestamp uses the new version at that ts', () => {
    const v1 = { effectiveFrom: '2024-01-03', weights: { 'stock:A': 1 } };
    const u = computeVersionUnits([v0, v1], daily, 100);
    const bars = buildBasketBars(u, both);
    // Jan3 bar uses v1 (7.5 * 20 = 150), not v0 (125)
    expect(bars[1]!.close).toBe(150);
  });

  it('late-listing constituent moves start and emits notice', () => {
    const late = { 'stock:A': daily['stock:A'], 'crypto:B': dailies('2024-01-03', [50, 50]) };
    const u = computeVersionUnits([{ ...v0, effectiveFrom: '2023-06-01' }], late, 100);
    expect(u.startTs).toBe(day('2024-01-04'));
    expect(u.notices[0]).toBe('Basket starts 2024-01-04: crypto:B has no data before that date.');
  });

  it('no notice when start is not moved', () => {
    expect(computeVersionUnits([v0], daily, 100).notices).toEqual([]);
  });

  it('throws when a constituent has no data', () => {
    expect(() => computeVersionUnits([v0], { 'stock:A': daily['stock:A'], 'crypto:B': [] }, 100)).toThrow(BasketValidationError);
  });

  it('throws when a later version adds a symbol with no prior data', () => {
    const d2 = { ...daily, 'stock:C': dailies('2024-01-04', [5]) };
    const v1 = { effectiveFrom: '2024-01-04', weights: { 'stock:C': 1 } };
    expect(() => computeVersionUnits([v0, v1], d2, 100)).toThrow(/stock:C/);
  });

  it('throws when a later version starts on/before effective start', () => {
    const v1 = { effectiveFrom: '2024-01-02', weights: { 'stock:A': 1 } };
    expect(() => computeVersionUnits([{ ...v0, effectiveFrom: '2024-01-01' }, v1], { ...daily, 'stock:A': dailies('2024-01-01', [10, 20, 20, 40]), 'crypto:B': dailies('2024-01-02', [100, 50, 50]) }, 100)).toThrow(BasketValidationError);
  });

  it('forward-fills missing bars on intraday grid (stock closed, crypto trading)', () => {
    const u = computeVersionUnits([v0], daily, 100);
    const t = day('2024-01-03');
    const H = 3_600_000;
    const stock = [bar(t - H, 20), bar(t + 14 * H, 22, 21, 23, 20)];
    const crypto = [bar(t, 100), bar(t + H, 90), bar(t + 14 * H, 80)];
    const out = buildBasketBars(u, [{ id: 'stock:A', bars: stock }, { id: 'crypto:B', bars: crypto }]);
    expect(out.map(b => b.ts)).toEqual([t, t + H, t + 14 * H]);
    expect(out[1]!.close).toBeCloseTo(5 * 20 + 0.5 * 90);
    expect(out[2]).toMatchObject({ open: 5 * 21 + 0.5 * 80, high: 5 * 23 + 0.5 * 80, low: 5 * 20 + 0.5 * 80, close: 5 * 22 + 0.5 * 80, volume: 0 });
  });

  it('skips timestamps until every constituent has a value', () => {
    const u = computeVersionUnits([v0], daily, 100);
    const t = day('2024-01-03');
    const out = buildBasketBars(u, [{ id: 'stock:A', bars: [bar(t + 5 * 3_600_000, 20)] }, { id: 'crypto:B', bars: [bar(t, 100), bar(t + 5 * 3_600_000, 100)] }]);
    expect(out.map(b => b.ts)).toEqual([t + 5 * 3_600_000]);
  });
});

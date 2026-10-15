import { describe, expect, it } from 'vitest';
import { BasketValidationError, MAX_BASKET_SYMBOLS, MAX_BASKET_VERSIONS, validateVersions } from '../src/basket.js';
import { utcDateString } from '../src/nytime.js';

const DAY = 86_400_000;
const date = (i: number) => utcDateString(Date.UTC(2020, 0, 1) + i * DAY);
const NOW = Date.UTC(2026, 0, 1);

describe('basket size caps', () => {
  it('at most MAX_BASKET_VERSIONS versions', () => {
    const versions = (n: number) => Array.from({ length: n }, (_, i) => ({ effectiveFrom: date(i), weights: { 'stock:A': 1 } }));
    expect(() => validateVersions(versions(MAX_BASKET_VERSIONS), { now: NOW })).not.toThrow();
    expect(() => validateVersions(versions(MAX_BASKET_VERSIONS + 1), { now: NOW })).toThrow(BasketValidationError);
  });

  it('at most MAX_BASKET_SYMBOLS distinct constituents across all versions', () => {
    // Each version holds 2 symbols; every version brings two new ones.
    const versions = (symbols: number) => Array.from({ length: symbols / 2 }, (_, i) => ({
      effectiveFrom: date(i), weights: { [`stock:S${2 * i}`]: 0.5, [`stock:S${2 * i + 1}`]: 0.5 },
    }));
    expect(() => validateVersions(versions(MAX_BASKET_SYMBOLS), { now: NOW })).not.toThrow();
    expect(() => validateVersions(versions(MAX_BASKET_SYMBOLS + 2), { now: NOW })).toThrow(/at most 100 different symbols/);
  });
});

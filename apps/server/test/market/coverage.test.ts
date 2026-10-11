import { describe, it, expect } from 'vitest';
import { missingRanges } from '../../src/market/coverage.js';

describe('missingRanges', () => {
  it('nothing covered → whole range', () => {
    expect(missingRanges([], 0, 10)).toEqual([[0, 10]]);
  });
  it('prefix covered', () => {
    expect(missingRanges([[0, 5]], 0, 10)).toEqual([[5, 10]]);
  });
  it('holes between covered ranges', () => {
    expect(missingRanges([[2, 4], [6, 8]], 0, 10)).toEqual([[0, 2], [4, 6], [8, 10]]);
  });
  it('fully covered → []', () => {
    expect(missingRanges([[-5, 20]], 0, 10)).toEqual([]);
    expect(missingRanges([[0, 4], [4, 10]], 0, 10)).toEqual([]);
  });
  it('from ≥ to → []', () => {
    expect(missingRanges([], 10, 10)).toEqual([]);
    expect(missingRanges([], 11, 10)).toEqual([]);
  });
  it('unsorted / overlapping / out-of-range coverage', () => {
    expect(missingRanges([[6, 12], [-3, 1], [3, 7]], 0, 10)).toEqual([[1, 3]]);
    expect(missingRanges([[20, 30]], 0, 10)).toEqual([[0, 10]]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSITION_DEFAULTS, isPositionTool, isValidPositionDefaults, MAX_POSITION_PCT, POSITION_TOOLS, resolvePositionDefaults,
} from '../src/types.js';

describe('position defaults', () => {
  it('app defaults: target and stop 2 % from the entry', () => {
    expect(DEFAULT_POSITION_DEFAULTS).toEqual({ targetPct: 2, stopPct: 2 });
    expect(MAX_POSITION_PCT).toBe(99);
  });

  it('position tools', () => {
    expect(POSITION_TOOLS).toEqual(['longPosition', 'shortPosition']);
    expect(isPositionTool('longPosition')).toBe(true);
    expect(isPositionTool('shortPosition')).toBe(true);
    expect(isPositionTool('segment')).toBe(false);
  });

  it('resolvePositionDefaults fills missing / invalid fields from the app defaults', () => {
    expect(resolvePositionDefaults(undefined)).toEqual(DEFAULT_POSITION_DEFAULTS);
    expect(resolvePositionDefaults(null)).toEqual(DEFAULT_POSITION_DEFAULTS);
    expect(resolvePositionDefaults('x')).toEqual(DEFAULT_POSITION_DEFAULTS);
    expect(resolvePositionDefaults({ targetPct: 3, stopPct: 1.5 })).toEqual({ targetPct: 3, stopPct: 1.5 });
    expect(resolvePositionDefaults({ targetPct: 4 })).toEqual({ targetPct: 4, stopPct: 2 });
    expect(resolvePositionDefaults({ targetPct: 0, stopPct: 100 })).toEqual(DEFAULT_POSITION_DEFAULTS);
    expect(resolvePositionDefaults({ targetPct: Number.NaN, stopPct: -1 })).toEqual(DEFAULT_POSITION_DEFAULTS);
  });

  it('resolvePositionDefaults ignores the sizing fields of layouts saved when positions were sized', () => {
    expect(resolvePositionDefaults({ accountSize: 2500, riskMode: 'amount', riskValue: 25, currency: 'CHF' })).toEqual(DEFAULT_POSITION_DEFAULTS);
  });

  it('isValidPositionDefaults: both distances in (0, 99]', () => {
    expect(isValidPositionDefaults(DEFAULT_POSITION_DEFAULTS)).toBe(true);
    expect(isValidPositionDefaults({ targetPct: 99, stopPct: 0.01 })).toBe(true);
    expect(isValidPositionDefaults({ targetPct: 150, stopPct: 2 })).toBe(false);
    expect(isValidPositionDefaults({ targetPct: 2, stopPct: 0 })).toBe(false);
  });
});

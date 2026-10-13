import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSITION_SETTINGS, isPositionTool, MAX_CURRENCY_LENGTH, POSITION_TOOLS, resolvePositionDefaults, sanitizePositionSettings,
} from '../src/types.js';

describe('position settings', () => {
  it('app defaults: 10 000 account, 1 % risk, USD', () => {
    expect(DEFAULT_POSITION_SETTINGS).toEqual({ accountSize: 10000, riskMode: 'percent', riskValue: 1, currency: 'USD' });
    expect(MAX_CURRENCY_LENGTH).toBe(8);
  });

  it('position tools', () => {
    expect(POSITION_TOOLS).toEqual(['longPosition', 'shortPosition']);
    expect(isPositionTool('longPosition')).toBe(true);
    expect(isPositionTool('shortPosition')).toBe(true);
    expect(isPositionTool('segment')).toBe(false);
  });

  it('sanitizePositionSettings keeps only valid fields', () => {
    expect(sanitizePositionSettings({ accountSize: 5000, riskMode: 'amount', riskValue: 50, currency: 'EUR' }))
      .toEqual({ accountSize: 5000, riskMode: 'amount', riskValue: 50, currency: 'EUR' });
    expect(sanitizePositionSettings({ accountSize: -1, riskMode: 'x', riskValue: Number.NaN, currency: 'TOOLONGCUR', bogus: 1 })).toBeUndefined();
    expect(sanitizePositionSettings({ accountSize: Infinity, riskValue: 2 })).toEqual({ riskValue: 2 });
    expect(sanitizePositionSettings({ currency: '' })).toBeUndefined();
    expect(sanitizePositionSettings({ currency: '  BTC ' })).toEqual({ currency: 'BTC' });
    expect(sanitizePositionSettings(null)).toBeUndefined();
    expect(sanitizePositionSettings('x')).toBeUndefined();
    expect(sanitizePositionSettings({})).toBeUndefined();
  });

  it('resolvePositionDefaults fills missing / invalid fields from the app defaults (backward compatible)', () => {
    expect(resolvePositionDefaults(undefined)).toEqual(DEFAULT_POSITION_SETTINGS);
    expect(resolvePositionDefaults({ accountSize: 2500, riskMode: 'amount', riskValue: 25, currency: 'CHF' }))
      .toEqual({ accountSize: 2500, riskMode: 'amount', riskValue: 25, currency: 'CHF' });
    expect(resolvePositionDefaults({ accountSize: 2500 } as never)).toEqual({ ...DEFAULT_POSITION_SETTINGS, accountSize: 2500 });
  });
});

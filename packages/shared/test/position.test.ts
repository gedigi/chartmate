import { describe, expect, it } from 'vitest';
import {
  convertRiskValue, DEFAULT_POSITION_SETTINGS, isPositionTool, isValidPositionDefaults, MAX_CURRENCY_LENGTH, MAX_POSITION_AMOUNT,
  MAX_RISK_PERCENT, POSITION_TOOLS, resolvePositionDefaults, sanitizePositionSettings,
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

  it('the same limits as the server: amounts ≤ 1e15, a percentage risk ≤ 100', () => {
    expect(MAX_POSITION_AMOUNT).toBe(1e15);
    expect(MAX_RISK_PERCENT).toBe(100);
    expect(sanitizePositionSettings({ accountSize: 2e15, riskValue: 2e15, riskMode: 'amount' })).toEqual({ riskMode: 'amount' });
    expect(sanitizePositionSettings({ riskMode: 'percent', riskValue: 500 })).toEqual({ riskMode: 'percent' });
    expect(sanitizePositionSettings({ riskMode: 'amount', riskValue: 500 })).toEqual({ riskMode: 'amount', riskValue: 500 });
    // Without a mode, a value over 100 is kept (it may be an amount); resolution caps it when the mode is percent.
    expect(sanitizePositionSettings({ riskValue: 500 })).toEqual({ riskValue: 500 });
    expect(resolvePositionDefaults({ riskValue: 500 } as never)).toEqual({ ...DEFAULT_POSITION_SETTINGS, riskValue: 100 });
  });

  it('isValidPositionDefaults', () => {
    expect(isValidPositionDefaults(DEFAULT_POSITION_SETTINGS)).toBe(true);
    expect(isValidPositionDefaults({ ...DEFAULT_POSITION_SETTINGS, riskValue: 500 })).toBe(false);
    expect(isValidPositionDefaults({ ...DEFAULT_POSITION_SETTINGS, riskMode: 'amount', riskValue: 500 })).toBe(true);
    expect(isValidPositionDefaults({ ...DEFAULT_POSITION_SETTINGS, accountSize: 0 })).toBe(false);
    expect(isValidPositionDefaults({ ...DEFAULT_POSITION_SETTINGS, currency: '' })).toBe(false);
  });

  it('convertRiskValue keeps the money at risk when the mode changes (percentage capped at 100)', () => {
    expect(convertRiskValue({ ...DEFAULT_POSITION_SETTINGS, riskMode: 'amount', riskValue: 500 }, 'percent')).toBe(5);
    expect(convertRiskValue({ ...DEFAULT_POSITION_SETTINGS, riskMode: 'amount', riskValue: 50000 }, 'percent')).toBe(100);
    expect(convertRiskValue({ ...DEFAULT_POSITION_SETTINGS, riskValue: 2.5 }, 'amount')).toBe(250);
    expect(convertRiskValue({ ...DEFAULT_POSITION_SETTINGS, accountSize: 3000, riskMode: 'amount', riskValue: 10 }, 'percent')).toBe(0.3333);
    expect(convertRiskValue({ ...DEFAULT_POSITION_SETTINGS, riskValue: 2 }, 'percent')).toBe(2);
  });
});

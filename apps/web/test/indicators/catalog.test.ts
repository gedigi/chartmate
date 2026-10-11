import { describe, expect, it } from 'vitest';
import { CATALOG, catalogEntry, indicatorLabel, validateParam } from '../../src/chart/indicators/catalog';

describe('CATALOG', () => {
  it('every entry has one label per default param', () => {
    for (const e of CATALOG) expect(e.paramLabels.length, e.name).toBe(e.defaultParams.length);
  });

  it('names are unique', () => {
    const names = CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains the built-ins and the custom VWAP/ATR with the agreed labels and defaults', () => {
    expect(catalogEntry('MA')).toMatchObject({ label: 'Moving Average (SMA)', pane: 'main', defaultParams: [5, 10, 30, 60] });
    expect(catalogEntry('SMA')).toMatchObject({ label: 'SMA (weighted, KLine)', pane: 'sub', defaultParams: [12, 2] });
    expect(catalogEntry('BOLL')).toMatchObject({ pane: 'main', defaultParams: [20, 2] });
    expect(catalogEntry('VWAP')).toMatchObject({ label: 'VWAP (session)', pane: 'main', defaultParams: [] });
    expect(catalogEntry('ATR')).toMatchObject({ label: 'Average True Range', pane: 'sub', defaultParams: [14] });
    expect(catalogEntry('RSI')).toMatchObject({ pane: 'sub', defaultParams: [6, 12, 24] });
    expect(catalogEntry('NOPE')).toBeUndefined();
    const expected = ['MA', 'EMA', 'BOLL', 'SAR', 'VWAP', 'BBI', 'VOL', 'MACD', 'RSI', 'KDJ', 'CCI', 'ATR', 'OBV', 'WR', 'DMI', 'ROC', 'MTM', 'TRIX', 'AO', 'SMA'];
    for (const n of expected) expect(catalogEntry(n), n).toBeDefined();
  });

  it('every line-colour slot is named and there are at most 5', () => {
    for (const e of CATALOG) {
      expect(e.lines.length, e.name).toBeLessThanOrEqual(5);
      for (const l of e.lines) expect(l.length).toBeGreaterThan(0);
    }
  });
});

describe('indicatorLabel', () => {
  it('shows the name with params, or just the name when there are none', () => {
    expect(indicatorLabel({ name: 'RSI', calcParams: [14] })).toBe('RSI(14)');
    expect(indicatorLabel({ name: 'BOLL', calcParams: [20, 2.5] })).toBe('BOLL(20, 2.5)');
    expect(indicatorLabel({ name: 'VWAP', calcParams: [] })).toBe('VWAP');
  });
});

describe('validateParam', () => {
  it('requires integers ≥ 1 by default', () => {
    expect(validateParam('RSI', 0, '14')).toBeNull();
    expect(validateParam('RSI', 0, '0')).toMatch(/whole number/i);
    expect(validateParam('RSI', 0, '2.5')).toMatch(/whole number/i);
    expect(validateParam('RSI', 0, '')).toMatch(/required/i);
    expect(validateParam('RSI', 0, 'abc')).toMatch(/number/i);
  });

  it('allows decimals > 0 for the BOLL std-dev and all SAR params', () => {
    expect(validateParam('BOLL', 1, '2.5')).toBeNull();
    expect(validateParam('BOLL', 1, '0')).toMatch(/greater than 0/i);
    expect(validateParam('BOLL', 0, '2.5')).toMatch(/whole number/i);
    expect(validateParam('SAR', 0, '0.5')).toBeNull();
    expect(validateParam('SAR', 2, '-1')).toMatch(/greater than 0/i);
  });
});

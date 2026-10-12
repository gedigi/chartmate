import { describe, expect, it } from 'vitest';
import { CATALOG, catalogEntry, defaultLineColor, indicatorLabel, migrateCalcParams, validateParam } from '../../src/chart/indicators/catalog';
import { CUSTOM_INDICATORS } from '../../src/chart/indicators/extensions';

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
    expect(catalogEntry('VWAP')).toMatchObject({ label: 'VWAP (session, intraday)', pane: 'main', defaultParams: [] });
    expect(catalogEntry('VWAP')!.description).toMatch(/1D and longer/);
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

describe('default line colours', () => {
  it('VWAP defaults to a colour distinct from the BOLL bands, in its template and in the settings defaults', () => {
    const vwap = defaultLineColor(0, 'VWAP');
    expect([0, 1, 2].map((i) => defaultLineColor(i, 'BOLL'))).not.toContain(vwap);
    const tpl = CUSTOM_INDICATORS.find((c) => c.catalog.name === 'VWAP')!.template;
    expect(tpl.styles?.lines?.[0]?.color).toBe(vwap);
    expect(defaultLineColor(0)).toBe('#ff9600');
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

  it('caps integer periods at 1000', () => {
    expect(validateParam('RSI', 0, '1000')).toBeNull();
    expect(validateParam('RSI', 0, '1001')).toBe('Must be at most 1000');
  });

  it('allows decimals > 0 for the BOLL std-dev and all SAR params', () => {
    expect(validateParam('BOLL', 1, '2.5')).toBeNull();
    expect(validateParam('BOLL', 1, '0')).toMatch(/greater than 0/i);
    expect(validateParam('BOLL', 0, '2.5')).toMatch(/whole number/i);
    expect(validateParam('SAR', 0, '0.5')).toBeNull();
    expect(validateParam('SAR', 2, '-1')).toMatch(/greater than 0/i);
  });
});

describe('migrateCalcParams', () => {
  it('pads stored params shorter than the catalog labels with the defaults', () => {
    expect(migrateCalcParams('RSI', [7])).toEqual([7, 12, 24]);
    expect(migrateCalcParams('RSI', [])).toEqual([6, 12, 24]);
  });
  it('drops extra params beyond the catalog labels and keeps complete ones unchanged', () => {
    expect(migrateCalcParams('RSI', [1, 2, 3, 4])).toEqual([1, 2, 3]);
    const full = [5, 6, 7];
    expect(migrateCalcParams('RSI', full)).toEqual(full);
  });
  it('leaves unknown indicators as stored', () => {
    expect(migrateCalcParams('NOPE', [1])).toEqual([1]);
  });
});

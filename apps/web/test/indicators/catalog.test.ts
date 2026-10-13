import { describe, expect, it } from 'vitest';
import { INDICATOR_PALETTE } from '../../src/chart/theme';
import { CATALOG, catalogEntry, defaultLineColor, defaultLineColors, indicatorLabel, migrateCalcParams, validateParam } from '../../src/chart/indicators/catalog';
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

  it('every line-color slot is named and there are at most 5', () => {
    for (const e of CATALOG) {
      expect(e.lines.length, e.name).toBeLessThanOrEqual(5);
      for (const l of e.lines) expect(l.length).toBeGreaterThan(0);
    }
  });
});

describe('default line colors (per-theme categorical palette)', () => {
  const DARK = ['#2488f7', '#e56c19', '#00b3c2', '#8d7cf8', '#e49916', '#f631aa'];
  const LIGHT = ['#1272da', '#eb6111', '#0095a0', '#541cdc', '#eda100', '#e12ca0'];
  // Slot (1-based) of each line, in figure order.
  const SLOTS: Record<string, number[]> = {
    MA: [1, 2, 3, 4], EMA: [1, 2, 3], BOLL: [2, 1, 3], SAR: [], BBI: [1], VWAP: [3], VOL: [1, 2, 3], MACD: [1, 2],
    RSI: [1, 2, 3], KDJ: [1, 2, 3], CCI: [1], ATR: [1], OBV: [1, 2], WR: [1, 2, 3], DMI: [1, 2, 3, 4], ROC: [1, 2],
    MTM: [1, 2], TRIX: [1, 2], AO: [], SMA: [1], WYCKOFF: [],
  };

  it('palettes are fixed per theme', () => {
    expect([...INDICATOR_PALETTE.dark]).toEqual(DARK);
    expect([...INDICATOR_PALETTE.light]).toEqual(LIGHT);
  });

  it('every catalog line takes the palette color of its documented slot, in both themes', () => {
    for (const e of CATALOG) {
      expect(SLOTS[e.name], `${e.name} mapping is documented`).toBeDefined();
      expect(defaultLineColors(e.name, 'dark'), e.name).toEqual(SLOTS[e.name]!.map((s) => DARK[s - 1]));
      expect(defaultLineColors(e.name, 'light'), e.name).toEqual(SLOTS[e.name]!.map((s) => LIGHT[s - 1]));
      expect(defaultLineColors(e.name, 'dark')).toHaveLength(e.lines.length);
    }
  });

  it('no indicator has more lines than palette slots (no wrapping), and lines within one indicator are distinct', () => {
    for (const e of CATALOG) {
      expect(e.lines.length, e.name).toBeLessThanOrEqual(INDICATOR_PALETTE.dark.length);
      expect(new Set(defaultLineColors(e.name, 'dark')).size, e.name).toBe(e.lines.length);
    }
  });

  it('VWAP is slot 3 (distinct from MA / BOLL slots 1-2), and its template carries no fixed color', () => {
    expect(defaultLineColor(0, 'VWAP', 'dark')).toBe('#00b3c2');
    expect(defaultLineColor(0, 'VWAP', 'light')).toBe('#0095a0');
    const tpl = CUSTOM_INDICATORS.find((c) => c.catalog.name === 'VWAP')!.template;
    expect(tpl.styles?.lines?.[0]?.color).toBeUndefined();
  });

  it('unknown indicators fall back to the palette by line index', () => {
    expect(defaultLineColor(1, undefined, 'light')).toBe('#eb6111');
    expect(defaultLineColor(0, 'NOPE', 'dark')).toBe('#2488f7');
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

  it('honors per-param integer ranges (WYCKOFF: sensitivity 0–50, lengths ≥ 1)', () => {
    expect(validateParam('WYCKOFF', 0, '14')).toBeNull();
    expect(validateParam('WYCKOFF', 0, '0')).toBe('Must be a whole number ≥ 1');
    expect(validateParam('WYCKOFF', 1, '0')).toBeNull();
    expect(validateParam('WYCKOFF', 1, '50')).toBeNull();
    expect(validateParam('WYCKOFF', 1, '51')).toBe('Must be at most 50');
    expect(validateParam('WYCKOFF', 1, '-1')).toBe('Must be a whole number ≥ 0');
    expect(validateParam('WYCKOFF', 1, '2.5')).toBe('Must be a whole number ≥ 0');
    expect(validateParam('WYCKOFF', 2, '0')).toBe('Must be a whole number ≥ 1');
    expect(validateParam('WYCKOFF', 2, '5')).toBeNull();
  });
});

describe('WYCKOFF catalog entry', () => {
  it('is an overlay with the agreed label, params and labels', () => {
    expect(catalogEntry('WYCKOFF')).toMatchObject({
      label: 'Wyckoff Accumulation and Distribution', pane: 'main', defaultParams: [14, 20, 5],
      paramLabels: ['RSI Length', 'Trend Sensitivity', 'Pivot Length'], lines: [],
      paramMin: [1, 0, 1], paramMax: [1000, 50, 1000],
    });
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCustomIndicators, customIndicatorProblem, CUSTOM_INDICATORS, PRICE_PRECISION_INDICATORS } from '../../src/chart/indicators/extensions';

const valid = () => ({
  template: { name: 'FOO', calc: () => [] },
  catalog: { name: 'FOO', label: 'Foo', pane: 'sub', defaultParams: [3], paramLabels: ['Period'], lines: ['FOO'] },
});

afterEach(() => vi.restoreAllMocks());

describe('customIndicatorProblem', () => {
  it('accepts a well-formed module', () => {
    expect(customIndicatorProblem(valid())).toBeNull();
    expect(customIndicatorProblem({ ...valid(), usePricePrecision: true })).toBeNull();
    expect(customIndicatorProblem({ ...valid(), catalog: { ...valid().catalog, paramMin: [0], paramMax: [50] } })).toBeNull();
  });

  it.each([
    ['not an object', 42, /object/],
    ['missing template name', { ...valid(), template: { calc: () => [] } }, /template\.name/],
    ['calc not a function', { ...valid(), template: { name: 'FOO', calc: 1 } }, /template\.calc/],
    ['name mismatch', { ...valid(), catalog: { ...valid().catalog, name: 'BAR' } }, /catalog\.name/],
    ['label not a string', { ...valid(), catalog: { ...valid().catalog, label: 5 } }, /catalog\.label/],
    ['bad pane', { ...valid(), catalog: { ...valid().catalog, pane: 'left' } }, /catalog\.pane/],
    ['non-finite default param', { ...valid(), catalog: { ...valid().catalog, defaultParams: [NaN] } }, /finite numbers/],
    ['string default param', { ...valid(), catalog: { ...valid().catalog, defaultParams: ['3'] } }, /finite numbers/],
    ['non-string param label', { ...valid(), catalog: { ...valid().catalog, paramLabels: [1] } }, /paramLabels/],
    ['length mismatch', { ...valid(), catalog: { ...valid().catalog, paramLabels: [] } }, /one label per default param/],
    ['non-string line', { ...valid(), catalog: { ...valid().catalog, lines: [null] } }, /catalog\.lines/],
    ['lines missing', { ...valid(), catalog: { ...valid().catalog, lines: undefined } }, /catalog\.lines/],
    ['paramMin not numbers', { ...valid(), catalog: { ...valid().catalog, paramMin: ['1'] } }, /catalog\.paramMin/],
    ['paramMax not numbers', { ...valid(), catalog: { ...valid().catalog, paramMax: 5 } }, /catalog\.paramMax/],
  ])('rejects %s', (_label, mod, msg) => {
    expect(customIndicatorProblem(mod)).toMatch(msg);
  });
});

describe('collectCustomIndicators', () => {
  it('keeps valid modules sorted by path and skips invalid ones with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = valid();
    const a = { ...valid(), template: { name: 'AAA', calc: () => [] }, catalog: { ...valid().catalog, name: 'AAA' } };
    const out = collectCustomIndicators({
      './custom/b.ts': { default: b },
      './custom/bad.ts': { default: { template: { name: 'X', calc: () => [] }, catalog: { name: 'X', label: 'X', pane: 'sub', defaultParams: [1], paramLabels: [], lines: [] } } },
      './custom/a.ts': { default: a },
      './custom/none.ts': {},
    });
    expect(out.map((c) => c.template.name)).toEqual(['AAA', 'FOO']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatch(/bad\.ts: catalog\.paramLabels must have one label per default param; skipped/);
  });

  it('ships VWAP, ATR and WYCKOFF from ./custom; ATR uses the price precision', () => {
    expect(CUSTOM_INDICATORS.map((c) => c.template.name)).toEqual(['ATR', 'VWAP', 'WYCKOFF']);
    expect([...PRICE_PRECISION_INDICATORS]).toEqual(['ATR']);
  });
});

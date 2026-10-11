import { describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => {
  const templates: unknown[] = [];
  return { templates, registerIndicator: vi.fn((t: unknown) => { templates.push(t); }) };
});
vi.mock('klinecharts', () => ({ registerIndicator: k.registerIndicator }));

const { registerCustomIndicators } = await import('../../src/chart/indicators/register');

type Template = {
  name: string; series?: string; calcParams?: number[]; figures?: Array<{ key: string }>;
  calc: (data: unknown[], indicator: { calcParams: number[]; extendData?: unknown }) => unknown[];
};
const registered = (name: string): Template => {
  const t = k.templates.find((x) => (x as Template).name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t as Template;
};

describe('registerCustomIndicators', () => {
  it('registers VWAP (price series, line "vwap") and ATR (line "atr") exactly once', () => {
    registerCustomIndicators();
    registerCustomIndicators();
    const names = k.templates.map((t) => (t as Template).name);
    expect(names.filter((n) => n === 'VWAP')).toHaveLength(1);
    expect(names.filter((n) => n === 'ATR')).toHaveLength(1);
    expect(registered('VWAP')).toMatchObject({ series: 'price', figures: [expect.objectContaining({ key: 'vwap' })] });
    expect(registered('ATR')).toMatchObject({ calcParams: [14], precision: 4, figures: [expect.objectContaining({ key: 'atr' })] });
  });

  it('VWAP resets on the NY date for stocks and on the UTC date for crypto', () => {
    const t = registered('VWAP');
    // 03:00 UTC and 05:00 UTC on 2024-01-11: same UTC date, but NY dates Jan 10 (22:00 EST) and Jan 11 (00:00 EST).
    const bars = [
      { timestamp: Date.UTC(2024, 0, 11, 3), open: 1, high: 10, low: 10, close: 10, volume: 1 },
      { timestamp: Date.UTC(2024, 0, 11, 5), open: 1, high: 20, low: 20, close: 20, volume: 1 },
    ];
    expect(t.calc(bars, { calcParams: [], extendData: { assetClass: 'stock' } })).toEqual([{ vwap: 10 }, { vwap: 20 }]);
    expect(t.calc(bars, { calcParams: [], extendData: { assetClass: 'basket' } })).toEqual([{ vwap: 10 }, { vwap: 20 }]);
    expect(t.calc(bars, { calcParams: [], extendData: { assetClass: 'crypto' } })).toEqual([{ vwap: 10 }, { vwap: 15 }]);
  });

  it('VWAP does not reset on 1D+ charts (intraday: false): it spans the whole loaded series', () => {
    const t = registered('VWAP');
    const day = 86_400_000;
    const bars = [
      { timestamp: 0, open: 1, high: 10, low: 10, close: 10, volume: 1 },
      { timestamp: day, open: 1, high: 20, low: 20, close: 20, volume: 3 },
      { timestamp: 2 * day, open: 1, high: 40, low: 40, close: 40, volume: 1 },
    ];
    expect(t.calc(bars, { calcParams: [], extendData: { assetClass: 'crypto', intraday: true } })).toEqual([{ vwap: 10 }, { vwap: 20 }, { vwap: 40 }]);
    // (10·1 + 20·3) / 4 = 17.5; (70 + 40) / 5 = 22
    expect(t.calc(bars, { calcParams: [], extendData: { assetClass: 'crypto', intraday: false } })).toEqual([{ vwap: 10 }, { vwap: 17.5 }, { vwap: 22 }]);
  });

  it('ATR uses its first calc param as the period', () => {
    const t = registered('ATR');
    const bars = [{ high: 3, low: 1, close: 2 }, { high: 4, low: 2, close: 3 }];
    expect(t.calc(bars, { calcParams: [1] })).toEqual([{ atr: 2 }, { atr: 2 }]);
    expect(t.calc(bars, { calcParams: [2] })).toEqual([{ atr: null }, { atr: 2 }]);
  });
});

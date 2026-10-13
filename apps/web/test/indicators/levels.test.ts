import { MAX_INDICATOR_LEVELS } from '@chartmate/shared';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG, catalogEntry, effectiveLevels } from '../../src/chart/indicators/catalog';
import { formatLevels, LEVEL_DASH, levelsDraw, levelsRange, parseLevels } from '../../src/chart/indicators/levels';
import { indicatorLevelColor, THEME_TOKENS } from '../../src/chart/theme';

describe('catalog reference levels', () => {
  it('oscillators carry their conventional levels', () => {
    const levels = Object.fromEntries(CATALOG.filter((e) => e.levels).map((e) => [e.name, e.levels]));
    expect(levels).toEqual({
      MACD: [0], AO: [0], ROC: [0], MTM: [0], TRIX: [0],
      RSI: [70, 30], KDJ: [80, 20], CCI: [100, -100], WR: [-20, -80], DMI: [25],
    });
  });

  it('overlays on the price pane, VOL and indicators without a convention have none', () => {
    for (const e of CATALOG.filter((x) => x.pane === 'main')) expect(e.levels, e.name).toBeUndefined();
    for (const name of ['VOL', 'OBV', 'SMA', 'ATR', 'WYCKOFF']) expect(catalogEntry(name)?.levels, name).toBeUndefined();
  });

  it('defaults are within the stored-layout bounds', () => {
    for (const e of CATALOG) if (e.levels) expect(e.levels.length).toBeLessThanOrEqual(MAX_INDICATOR_LEVELS);
  });

  it('effectiveLevels: missing → defaults, stored values win, hidden or no catalog levels → none', () => {
    expect(effectiveLevels({ name: 'RSI' })).toEqual([70, 30]);
    expect(effectiveLevels({ name: 'RSI', levels: [80, 50, 20] })).toEqual([80, 50, 20]);
    expect(effectiveLevels({ name: 'RSI', levels: [] })).toEqual([]);
    expect(effectiveLevels({ name: 'RSI', showLevels: false })).toEqual([]);
    expect(effectiveLevels({ name: 'RSI', showLevels: true })).toEqual([70, 30]);
    expect(effectiveLevels({ name: 'MA', levels: [1] })).toEqual([]);
    expect(effectiveLevels({ name: 'NOPE' })).toEqual([]);
  });
});

describe('levelsDraw', () => {
  const setup = () => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
      lineWidth: 0, strokeStyle: '',
    };
    // value → pixel: 100 at the top (y 0), 0 at the bottom (y 200).
    const yAxis = { convertToPixel: vi.fn((v: number) => 200 - v * 2) };
    const params = { ctx, yAxis, bounding: { width: 300, height: 200 } } as never;
    return { ctx, yAxis, params };
  };

  it('strokes each visible level as a 1px dashed line across the pane and keeps the default figures (returns false)', () => {
    const { ctx, params } = setup();
    expect(levelsDraw([70, 30], () => '#abc')(params)).toBe(false);
    expect(ctx.setLineDash).toHaveBeenCalledWith(LEVEL_DASH);
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.strokeStyle).toBe('#abc');
    expect(ctx.moveTo.mock.calls).toEqual([[0, 60.5], [0, 140.5]]);
    expect(ctx.lineTo.mock.calls).toEqual([[300, 60.5], [300, 140.5]]);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it('skips levels outside the pane and draws nothing without levels', () => {
    const { ctx, params } = setup();
    levelsDraw([150, -20, 50], () => '#abc')(params);
    expect(ctx.moveTo.mock.calls).toEqual([[0, 100.5]]);
    const empty = setup();
    levelsDraw([], () => '#abc')(empty.params);
    expect(empty.ctx.stroke).not.toHaveBeenCalled();
  });

  it('reads the color on every draw (theme toggles) and composes with a template draw', () => {
    const { ctx, params } = setup();
    let color = 'dark';
    const inner = vi.fn(() => true);
    const draw = levelsDraw([0], () => color, inner);
    expect(draw(params)).toBe(true);
    expect(inner).toHaveBeenCalledWith(params);
    color = 'light';
    draw(params);
    expect(ctx.strokeStyle).toBe('light');
  });

  it('levelsRange widens the auto-range to the levels; no levels → plain auto-range', () => {
    expect(levelsRange([70, 30])).toEqual({ minValue: 30, maxValue: 70 });
    expect(levelsRange([0])).toEqual({ minValue: 0, maxValue: 0 });
    expect(levelsRange([])).toEqual({ minValue: null, maxValue: null });
  });

  it('the level color is the theme muted color, translucent, per theme', () => {
    expect(indicatorLevelColor('dark')).toMatch(/^rgba\(\d+,\d+,\d+,0\.55\)$/);
    expect(indicatorLevelColor('dark')).not.toBe(indicatorLevelColor('light'));
    const n = parseInt(THEME_TOKENS.light.muted.slice(1), 16);
    expect(indicatorLevelColor('light')).toBe(`rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.55)`);
  });
});

describe('levels text', () => {
  it('formats and parses comma / space separated numbers', () => {
    expect(formatLevels([70, 30])).toBe('70, 30');
    expect(parseLevels('70, 30')).toEqual({ levels: [70, 30] });
    expect(parseLevels(' -20 -80.5 ')).toEqual({ levels: [-20, -80.5] });
    expect(parseLevels('')).toEqual({ levels: [] });
  });

  it('rejects non-numbers, huge values and more than the maximum', () => {
    expect(parseLevels('70, abc')).toHaveProperty('error');
    expect(parseLevels('1e13')).toHaveProperty('error');
    expect(parseLevels('1 2 3 4 5 6')).toEqual({ error: `At most ${MAX_INDICATOR_LEVELS} levels` });
  });
});

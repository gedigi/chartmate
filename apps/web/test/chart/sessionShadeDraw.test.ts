import { describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => ({ templates: [] as Array<{ name: string; draw: (p: unknown) => boolean }> }));
vi.mock('klinecharts', () => ({ registerIndicator: (t: { name: string; draw: (p: unknown) => boolean }) => { k.templates.push(t); } }));

const { registerSessionShade, SESSION_SHADE, sessionShadeFill } = await import('../../src/chart/sessionShade');
const { indicatorColorContext } = await import('../../src/chart/indicators/colors');
const { THEME_TOKENS } = await import('../../src/chart/theme');
const { compositeOver } = await import('../../src/chart/color');

describe('SESSION_SHADE draw', () => {
  it('positions runs from the known data index (xAxis.convertToPixel), never a timestamp search', () => {
    registerSessionShade();
    const tpl = k.templates.find((t) => t.name === SESSION_SHADE)!;
    const data = [
      { timestamp: 1, session: 'pre' }, { timestamp: 2, session: 'pre' }, { timestamp: 3, session: 'regular' },
      { timestamp: 4, session: 'post' }, { timestamp: 5, session: 'regular' },
    ];
    const xAxis = { convertToPixel: vi.fn((i: number) => i * 10), convertTimestampToPixel: vi.fn(() => 0) };
    const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
    tpl.draw({
      ctx, xAxis, bounding: { height: 100 },
      chart: {
        getDataList: () => data,
        getVisibleRange: () => ({ realFrom: 0, realTo: 5 }),
        getBarSpace: () => ({ bar: 8, halfBar: 4 }),
      },
    });
    expect(xAxis.convertTimestampToPixel).not.toHaveBeenCalled();
    expect(xAxis.convertToPixel.mock.calls.map((c) => c[0])).toEqual([0, 1, 3, 3]);
    expect(ctx.fillRect.mock.calls).toEqual([[-4, 0, 18, 100], [26, 0, 8, 100]]);
  });

  it('fills with the active theme\'s session token: a translucent rgba that lands exactly on it over the chart background', () => {
    for (const theme of ['dark', 'light'] as const) {
      indicatorColorContext.theme = theme;
      const fill = sessionShadeFill();
      expect(fill).toMatch(/^rgba\(/); // translucent: the candles under the shade keep their colors
      expect(compositeOver(fill, THEME_TOKENS[theme].bg)).toBe(THEME_TOKENS[theme].session);
      registerSessionShade();
      const tpl = k.templates.find((t) => t.name === SESSION_SHADE)!;
      const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
      const xAxis = { convertToPixel: (i: number) => i * 10 };
      tpl.draw({
        ctx, xAxis, bounding: { height: 100 },
        chart: { getDataList: () => [{ timestamp: 1, session: 'pre' }], getVisibleRange: () => ({ realFrom: 0, realTo: 1 }), getBarSpace: () => ({ bar: 8, halfBar: 4 }) },
      });
      expect(ctx.fillStyle).toBe(fill);
    }
    indicatorColorContext.theme = 'dark';
  });
});

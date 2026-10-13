import { beforeEach, describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => ({ templates: new Map<string, Record<string, any>>() }));
vi.mock('klinecharts', async () => {
  const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
  return { getOverlayClass: actual.getOverlayClass, registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); } };
});

const P = await import('../../src/chart/positionOverlay');
const { drawingConstraint } = await import('../../src/chart/drawingTemplates');
const { toPositionPoints } = await import('../../src/chart/position');
const { POSITION_STYLE_KEY, positionContext, positionFigures, positionSettingsOf, registerPositionOverlays } = P;

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const g = { start: T0, end: T0 + 20 * DAY, entry: 100, target: 102, stop: 98 };
const colors = { up: '#26a69a', down: '#ef5350', neutral: '#868b98' };
const settings = { accountSize: 10000, riskMode: 'percent' as const, riskValue: 1, currency: 'USD' };
const coords = [{ x: 10, y: 100 }, { x: 10, y: 80 }, { x: 10, y: 120 }, { x: 210, y: 100 }];
const base = {
  side: 'long' as const, g, coords, settings, precision: 2, qtyDecimals: 0, colors, bars: [] as Array<{ timestamp: number; high: number; low: number; close: number }>,
  xOf: (ts: number) => 10 + ((ts - T0) / DAY) * 10, yOf: (v: number) => 100 - (v - 100) * 10,
  formatTime: (ts: number) => new Date(ts).toISOString().slice(0, 10), font: { family: 'Arial', size: 12 },
};
type Fig = { type: string; attrs: any; styles?: any; ignoreEvent?: unknown };
const texts = (f: Fig[]) => f.filter((x) => x.type === 'text').map((x) => x.attrs.text as string);

describe('positionFigures', () => {
  it('profit zone (entry→target, up colour 20 %) and loss zone (entry→stop, down colour 20 %) from entry to end time', () => {
    const f = positionFigures(base) as Fig[];
    const rects = f.filter((x) => x.type === 'rect');
    expect(rects[0]).toMatchObject({ attrs: { x: 10, y: 80, width: 200, height: 20 }, styles: { style: 'fill', color: 'rgba(38,166,154,0.2)' } });
    expect(rects[1]).toMatchObject({ attrs: { x: 10, y: 100, width: 200, height: 20 }, styles: { style: 'fill', color: 'rgba(239,83,80,0.2)' } });
    expect(f.find((x) => x.type === 'line')).toMatchObject({ attrs: { coordinates: [{ x: 10, y: 100 }, { x: 210, y: 100 }] } });
  });

  it('labels: target, stop, centre (contrast-aware text, theme font), no outcome while pending', () => {
    const f = positionFigures(base) as Fig[];
    expect(texts(f)).toEqual(['Target: 102.00 (+2.00%) +100.00 USD', 'Stop: 98.00 (-2.00%) -100.00 USD', 'Long · Qty 50 · R:R 1.00']);
    const target = f.find((x) => x.type === 'text')!;
    expect(target.ignoreEvent).toBe(true);
    expect(target.styles).toMatchObject({ backgroundColor: '#26a69a', color: '#ffffff', family: 'Arial', size: 12 });
    expect(target.attrs).toMatchObject({ x: 110, y: 78, align: 'center', baseline: 'bottom' });
    const stop = f.filter((x) => x.type === 'text')[1]!;
    expect(stop.attrs).toMatchObject({ y: 122, baseline: 'top' });
    const light = positionFigures({ ...base, colors: { ...colors, up: '#c8f7c5' } }) as Fig[];
    expect(light.find((x) => x.type === 'text')!.styles.color).toBe('#131722');
  });

  it('target hit: label with P&L and date, the profit zone shaded more strongly up to the hit bar', () => {
    const bars = [{ timestamp: T0 + 3 * DAY, high: 101, low: 99, close: 100 }, { timestamp: T0 + 5 * DAY, high: 103, low: 99, close: 102 }];
    const f = positionFigures({ ...base, bars }) as Fig[];
    expect(texts(f)).toContain('Target hit · +100.00 USD (+2.00%) · 2024-01-06');
    const strong = f.filter((x) => x.type === 'rect')[2]!;
    expect(strong).toMatchObject({ attrs: { x: 10, y: 80, width: 50, height: 20 }, styles: { color: 'rgba(38,166,154,0.4)' } });
  });

  it('stop hit shades the loss zone; open shades from the entry to the last close', () => {
    const stop = positionFigures({ ...base, bars: [{ timestamp: T0 + 2 * DAY, high: 100, low: 97, close: 98 }] }) as Fig[];
    expect(texts(stop)).toContain('Stop hit · -100.00 USD (-2.00%) · 2024-01-03');
    expect(stop.filter((x) => x.type === 'rect')[2]).toMatchObject({ attrs: { x: 10, y: 100, width: 20, height: 20 }, styles: { color: 'rgba(239,83,80,0.4)' } });
    const open = positionFigures({ ...base, bars: [{ timestamp: T0 + 4 * DAY, high: 101.5, low: 99, close: 101 }] }) as Fig[];
    expect(texts(open)).toContain('Open · +50.00 USD (+1.00%)');
    expect(open.filter((x) => x.type === 'rect')[2]).toMatchObject({ attrs: { x: 10, y: 90, width: 40, height: 10 } });
  });

  it('nothing without the four points', () => {
    expect(positionFigures({ ...base, coords: coords.slice(0, 1) })).toEqual([]);
  });
});

describe('position settings resolution', () => {
  it('own settings (overlay styles) over the defaults', () => {
    positionContext.defaults = { ...settings, currency: 'EUR' };
    expect(positionSettingsOf(null)).toEqual({ ...settings, currency: 'EUR' });
    expect(positionSettingsOf({ [POSITION_STYLE_KEY]: { riskValue: 2, bogus: 1 } })).toEqual({ ...settings, currency: 'EUR', riskValue: 2 });
  });
});

describe('position overlay templates', () => {
  beforeEach(() => {
    k.templates.clear();
    registerPositionOverlays(true);
  });

  it('registers longPosition / shortPosition: one click (totalStep 2), default point handles', () => {
    for (const name of ['longPosition', 'shortPosition']) {
      const t = k.templates.get(name)!;
      expect(t).toMatchObject({ name, totalStep: 2, needDefaultPointFigure: true });
    }
  });

  it('while placing, the entry point drags the default target / stop (±2 %) and end (endFor) along', () => {
    drawingConstraint.precision = 2;
    positionContext.endFor = (ts) => ts + 20 * DAY;
    const points: any[] = [{ timestamp: T0, value: 100.004 }];
    k.templates.get('shortPosition')!.performEventMoveForDrawing({ points, performPointIndex: 0, currentStep: 1, mode: 'normal', performPoint: points[0] });
    expect(points).toEqual([
      { timestamp: T0, value: 100.004 }, { timestamp: T0, value: 98 }, { timestamp: T0, value: 102 }, { timestamp: T0 + 20 * DAY, value: 100 },
    ]);
  });

  it('point drags follow the position drag rules', () => {
    drawingConstraint.precision = 2;
    positionContext.barMs = DAY;
    const points: any[] = toPositionPoints(g);
    points[1] = { timestamp: T0 + DAY, value: 104 };
    k.templates.get('longPosition')!.performEventPressedMove({ points, performPointIndex: 1, currentStep: -1, mode: 'normal', performPoint: points[1] });
    expect(points[1]).toEqual({ timestamp: T0, value: 104 });
  });
});

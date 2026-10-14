import { describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => ({ templates: new Map<string, Record<string, any>>() }));
vi.mock('klinecharts', () => ({ registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); } }));

const M = await import('../../src/chart/measure');
const { parseColor } = await import('../../src/chart/color');
const { readableTextOn } = await import('../../src/chart/contrast');
const { formatSigned, formatSpan, measureColors, measureFigures, measureLines, measureStats, MEASURE_OVERLAY, registerMeasureOverlay, snapValue } = M;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2024, 0, 1);
type B = { timestamp: number; open: number; high: number; low: number; close: number; volume?: number };
const bar = (i: number, close: number, volume?: number): B => ({
  timestamp: T0 + i * DAY, open: close, high: close + 1, low: close - 1, close, ...(volume === undefined ? {} : { volume }),
});

describe('formatSigned', () => {
  it('signs with + and a true minus, at the given precision', () => {
    expect(formatSigned(1.234, 2)).toBe('+1.23');
    expect(formatSigned(-0.5, 3)).toBe('−0.500');
    expect(formatSigned(0, 2)).toBe('0.00');
    expect(formatSigned(-0.001, 2)).toBe('0.00'); // rounds to zero: no sign
  });
});

describe('formatSpan', () => {
  it('shows the two largest units', () => {
    expect(formatSpan(45 * 60_000)).toBe('45m');
    expect(formatSpan(2 * HOUR + 30 * 60_000)).toBe('2h 30m');
    expect(formatSpan(3 * HOUR)).toBe('3h');
    expect(formatSpan(3 * DAY + 4 * HOUR + 59 * 60_000)).toBe('3d 4h');
    expect(formatSpan(16 * DAY)).toBe('16d');
    expect(formatSpan(400 * DAY)).toBe('1y 35d');
    expect(formatSpan(730 * DAY)).toBe('2y');
  });
  it('is unsigned and never empty', () => {
    expect(formatSpan(-2 * HOUR)).toBe('2h');
    expect(formatSpan(0)).toBe('0m');
    expect(formatSpan(20_000)).toBe('0m');
  });
});

describe('measureStats', () => {
  const bars = [bar(0, 100, 10), bar(1, 101, 20), bar(2, 102, 30), bar(3, 103, 40)];
  it('change, percent, bars, span and the volume summed over the bars covered (both ends included)', () => {
    const s = measureStats({ index: 1, timestamp: bars[1]!.timestamp, value: 100 }, { index: 3, timestamp: bars[3]!.timestamp, value: 110 }, bars);
    expect(s).toEqual({ change: 10, percent: 10, bars: 2, spanMs: 2 * DAY, volume: 90, up: true });
  });
  it('is down below the start price; leftward measurements count negative bars', () => {
    const s = measureStats({ index: 3, timestamp: bars[3]!.timestamp, value: 100 }, { index: 0, timestamp: bars[0]!.timestamp, value: 95 }, bars);
    expect(s.up).toBe(false);
    expect(s.change).toBe(-5);
    expect(s.percent).toBe(-5);
    expect(s.bars).toBe(-3);
    expect(s.spanMs).toBe(3 * DAY);
    expect(s.volume).toBe(100);
  });
  it('an unchanged price counts as up; a zero start price has no percent', () => {
    expect(measureStats({ index: 0, timestamp: T0, value: 100 }, { index: 1, timestamp: T0 + DAY, value: 100 }, bars).up).toBe(true);
    expect(measureStats({ index: 0, timestamp: T0, value: 0 }, { index: 1, timestamp: T0 + DAY, value: 1 }, bars).percent).toBeNull();
  });
  it('counts actual bars (a weekend gap is one bar), volume only over loaded bars, none without volume', () => {
    const gap = [bar(0, 1, 5), bar(3, 2, 7)]; // Friday → Monday
    const s = measureStats({ index: 0, timestamp: gap[0]!.timestamp, value: 1 }, { index: 1, timestamp: gap[1]!.timestamp, value: 2 }, gap);
    expect(s.bars).toBe(1);
    expect(s.spanMs).toBe(3 * DAY);
    expect(s.volume).toBe(12);
    // Into the future area: extrapolated indexes, volume over the loaded bars only.
    const f = measureStats({ index: 0, timestamp: gap[0]!.timestamp, value: 1 }, { index: 4, timestamp: gap[1]!.timestamp + 3 * DAY, value: 2 }, gap);
    expect(f.bars).toBe(4);
    expect(f.volume).toBe(12);
    expect(measureStats({ index: 0, timestamp: T0, value: 1 }, { index: 1, timestamp: T0 + DAY, value: 2 }, [bar(0, 1), bar(1, 2)]).volume).toBeNull();
    expect(measureStats({ index: 0, timestamp: T0, value: 1 }, { index: 1, timestamp: T0 + DAY, value: 2 }, [bar(0, 1, 0), bar(1, 2, 0)]).volume).toBeNull();
  });
});

describe('measureLines', () => {
  it('price change and percent, then bars and span, then volume', () => {
    expect(measureLines({ change: 1.5, percent: 0.4567, bars: 12, spanMs: 3 * DAY + 4 * HOUR, volume: 1_234_567, up: true }, 2))
      .toEqual(['+1.50 (+0.46%)', '12 bars, 3d 4h', 'Vol 1.23M']);
    expect(measureLines({ change: -0.25, percent: -2, bars: -1, spanMs: DAY, volume: null, up: false }, 2))
      .toEqual(['−0.25 (−2.00%)', '−1 bar, 1d']);
    expect(measureLines({ change: 0, percent: null, bars: 0, spanMs: 0, volume: null, up: true }, 4))
      .toEqual(['0.0000', '0 bars']);
  });
});

describe('snapValue', () => {
  const b = { open: 100, high: 105, low: 95, close: 102 };
  const yOf = (v: number) => 500 - v * 2; // 2 px per unit
  it('normal mode keeps the price', () => {
    expect(snapValue(103.3, b, 'normal', yOf)).toBe(103.3);
  });
  it('strong magnet: the nearest of open / high / low / close', () => {
    expect(snapValue(103.3, b, 'strong_magnet', yOf)).toBe(102);
    expect(snapValue(120, b, 'strong_magnet', yOf)).toBe(105);
  });
  it('weak magnet: snaps only within a few pixels, like drawings', () => {
    expect(snapValue(104, b, 'weak_magnet', yOf)).toBe(105); // 2 px away
    expect(snapValue(112, b, 'weak_magnet', yOf)).toBe(112); // 14 px away
  });
  it('without a bar (future area) the price is kept', () => {
    expect(snapValue(103.3, null, 'strong_magnet', yOf)).toBe(103.3);
  });
});

describe('measureColors', () => {
  const palette = { up: '#0b9da0', down: '#c43d68', bg: '#fafbfd' };
  it('up family for up, down family for down; translucent fill, readable label text', () => {
    const up = measureColors(true, palette);
    const down = measureColors(false, palette);
    expect(up.stroke).toBe('#0b9da0');
    expect(down.stroke).toBe('#c43d68');
    expect(up.label).toBe('#0b9da0');
    expect(up.labelText).toBe(readableTextOn('#0b9da0'));
    expect(parseColor(up.fill)!.alpha).toBeLessThan(0.2);
    expect(parseColor(down.fill)!.alpha).toBeLessThan(0.2);
    // Same hue family as the strong color (green-blue vs red channel dominance).
    const [ur, , ub] = parseColor(up.fill)!.rgb;
    const [dr, , db] = parseColor(down.fill)!.rgb;
    expect(ub).toBeGreaterThan(ur);
    expect(dr).toBeGreaterThan(db);
  });
});

describe('measureFigures', () => {
  const view = { lines: ['+1.50 (+0.46%)', '12 bars, 3d 4h'], colors: measureColors(true, { up: '#3ccfd0', down: '#e76a88', bg: '#0c0f18' }), font: 'Arial' };
  type Fig = { type: string; attrs: any; styles?: any; ignoreEvent?: unknown };
  const figs = (c: Array<{ x: number; y: number }>, over: Partial<{ paneWidth: number; paneHeight: number }> = {}) =>
    measureFigures({ coords: c, view, paneWidth: 800, paneHeight: 400, ...over }) as Fig[];

  it('a tinted box between the points, dashed guide arrows, a label; nothing reacts to the mouse', () => {
    const f = figs([{ x: 100, y: 300 }, { x: 300, y: 100 }]);
    const box = f.find((x) => x.type === 'rect' && x.styles.color === view.colors.fill)!;
    expect(box.attrs).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    const lines = f.filter((x) => x.type === 'line');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.styles).toMatchObject({ style: 'dashed', color: view.colors.stroke, size: 1 });
    expect(lines.map((l) => l.attrs.coordinates)).toEqual([
      [{ x: 100, y: 200 }, { x: 300, y: 200 }],
      [{ x: 200, y: 300 }, { x: 200, y: 100 }],
    ]);
    expect(f.filter((x) => x.type === 'polygon')).toHaveLength(2); // arrowheads at the end
    expect(f.filter((x) => x.type === 'text').map((x) => x.attrs.text)).toEqual(view.lines);
    expect(f.every((x) => x.ignoreEvent === true)).toBe(true);
  });

  it('the label sits beyond the end price: above an up box, below a down box', () => {
    const textY = (f: Fig[]) => f.find((x) => x.type === 'text')!.attrs.y as number;
    expect(textY(figs([{ x: 100, y: 300 }, { x: 300, y: 200 }]))).toBeLessThan(200);
    expect(textY(figs([{ x: 100, y: 100 }, { x: 300, y: 200 }]))).toBeGreaterThan(200);
  });

  it('keeps the label inside the pane', () => {
    const f = figs([{ x: 780, y: 30 }, { x: 790, y: 10 }]);
    const bg = f.find((x) => x.type === 'rect' && x.styles.color === view.colors.label)!;
    expect(bg.attrs.x + bg.attrs.width).toBeLessThanOrEqual(800);
    expect(bg.attrs.y).toBeGreaterThanOrEqual(0);
  });

  it('no arrowheads on guides too short to carry them; nothing without both points', () => {
    expect(figs([{ x: 100, y: 100 }, { x: 104, y: 103 }]).filter((x) => x.type === 'polygon')).toHaveLength(0);
    expect(figs([{ x: 100, y: 100 }])).toEqual([]);
  });
});

describe('registerMeasureOverlay', () => {
  it('registers a non-interactive two-point overlay without handles or axis labels', () => {
    registerMeasureOverlay(true);
    const t = k.templates.get(MEASURE_OVERLAY)!;
    expect(t).toMatchObject({ totalStep: 3, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false });
    const view = { lines: ['x'], colors: measureColors(false, { up: '#3ccfd0', down: '#e76a88', bg: '#0c0f18' }), font: 'Arial' };
    const out = t.createPointFigures({ coordinates: [{ x: 0, y: 0 }, { x: 50, y: 50 }], overlay: { extendData: view }, bounding: { width: 400, height: 300 } });
    expect(out.length).toBeGreaterThan(0);
    expect(t.createPointFigures({ coordinates: [{ x: 0, y: 0 }, { x: 50, y: 50 }], overlay: { extendData: null }, bounding: { width: 400, height: 300 } })).toEqual([]);
  });
});

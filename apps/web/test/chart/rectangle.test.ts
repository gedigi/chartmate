import { beforeEach, describe, expect, it, vi } from 'vitest';

// registerOverlay is captured: the template is exercised directly (no canvas needed).
const k = vi.hoisted(() => ({ templates: new Map<string, Record<string, any>>() }));
vi.mock('klinecharts', async () => {
  const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
  return {
    getOverlayClass: actual.getOverlayClass,
    registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); },
  };
});

const R = await import('../../src/chart/rectangle');
const T = await import('../../src/chart/drawingTemplates');
const { zoneTint } = await import('../../src/chart/color');
const { THEME_TOKENS } = await import('../../src/chart/theme');
const { ZONE_WEIGHT } = await import('../../src/chart/positionOverlay');

type P = { timestamp?: number; value?: number; dataIndex?: number };
type Fig = { type: string; attrs: any; styles?: any; ignoreEvent?: unknown };

const A = { timestamp: 1000, value: 10 };
const B = { timestamp: 5000, value: 30 };
const tv = (ps: P[]) => ps.map((p) => [p.timestamp, p.value]);

describe('rectangle points', () => {
  it('two corners expand to the eight handles: corners, the other two corners, then the four edge midpoints', () => {
    expect(tv(R.rectanglePoints(A, B))).toEqual([
      [1000, 10], [5000, 30], // the two clicked (stored) corners
      [1000, 30], [5000, 10], // the other two corners
      [1000, 10], [5000, 30], // the vertical edges' midpoints (drawn halfway; they carry an existing price)
      [1000, 10], [5000, 30], // the horizontal edges' midpoints (drawn halfway; they carry an existing time)
    ]);
  });

  it('stored points are the two clicked corners (eight handles collapse to two; other drawings are untouched)', () => {
    const eight = R.rectanglePoints(A, B) as Array<{ timestamp: number; value: number }>;
    expect(R.persistedPoints('rectangle', eight)).toEqual([A, B]);
    const seg = [A, B, { timestamp: 9, value: 9 }];
    expect(R.persistedPoints('segment', seg)).toBe(seg);
  });

  it('resizing: corners move both edges they touch, edge midpoints move only their edge (in place)', () => {
    const cases: Array<[number, P, [number, number, number, number]]> = [
      // index, dragged to, expected [tA, vA, tB, vB]
      [0, { timestamp: 2000, value: 12 }, [2000, 12, 5000, 30]],
      [1, { timestamp: 7000, value: 40 }, [1000, 10, 7000, 40]],
      [2, { timestamp: 1500, value: 35 }, [1500, 10, 5000, 35]], // (tA, vB) corner
      [3, { timestamp: 6000, value: 5 }, [1000, 5, 6000, 30]], // (tB, vA) corner
      [4, { timestamp: 500, value: 99 }, [500, 10, 5000, 30]], // A's vertical edge: time only
      [5, { timestamp: 8000, value: 99 }, [1000, 10, 8000, 30]], // B's vertical edge: time only
      [6, { timestamp: 99, value: 8 }, [1000, 8, 5000, 30]], // A's horizontal edge: price only
      [7, { timestamp: 99, value: 33 }, [1000, 10, 5000, 33]], // B's horizontal edge: price only
    ];
    for (const [i, to, [tA, vA, tB, vB]] of cases) {
      const pts: P[] = R.rectanglePoints(A, B);
      const ref = pts;
      pts[i] = { ...pts[i], ...to };
      R.resizeRectangle(pts, i);
      expect(pts, `handle ${i}`).toBe(ref);
      expect(tv(pts), `handle ${i}`).toEqual(tv(R.rectanglePoints({ timestamp: tA, value: vA }, { timestamp: tB, value: vB })));
    }
  });

  it('a corner dragged past the opposite one just flips the box (no error, still eight points)', () => {
    const pts: P[] = R.rectanglePoints(A, B);
    pts[0] = { timestamp: 9000, value: 50 };
    R.resizeRectangle(pts, 0);
    expect(tv(pts.slice(0, 2))).toEqual([[9000, 50], [5000, 30]]);
    expect(pts).toHaveLength(8);
  });

  it('two points (restore, paste) expand to eight; incomplete points are left alone', () => {
    const two: P[] = [{ ...A }, { ...B }];
    R.resizeRectangle(two, 1);
    expect(tv(two)).toEqual(tv(R.rectanglePoints(A, B)));
    const one: P[] = [{ ...A }];
    R.resizeRectangle(one, 0);
    expect(one).toHaveLength(1);
    const broken: P[] = [{ ...A }, { timestamp: 5 }];
    R.resizeRectangle(broken, 1);
    expect(broken).toHaveLength(2);
  });
});

describe('rectangle geometry', () => {
  it('the box is pixel aligned (integer edges), whichever corner comes first', () => {
    expect(R.rectangleBox({ x: 100.4, y: 80.6 }, { x: 20.5, y: 10.2 })).toEqual({ left: 21, top: 10, right: 100, bottom: 81 });
    expect(R.rectangleBox({ x: 20, y: 10 }, { x: 100, y: 81 })).toEqual({ left: 20, top: 10, right: 100, bottom: 81 });
  });

  it('borders: four axis-aligned lines; horizontal ones reach over the vertical ones so the corners are closed', () => {
    const box = { left: 20, top: 10, right: 100, bottom: 80 };
    // 1 px: KLineChart shifts odd widths by 0.5 px; the vertical edges cover columns 20 and 100 → the horizontal
    // ones span [20, 101).
    expect(R.borderLines(box, 1)).toEqual([
      { coordinates: [{ x: 20, y: 10 }, { x: 101, y: 10 }] },
      { coordinates: [{ x: 20, y: 80 }, { x: 101, y: 80 }] },
      { coordinates: [{ x: 20, y: 10 }, { x: 20, y: 80 }] },
      { coordinates: [{ x: 100, y: 10 }, { x: 100, y: 80 }] },
    ]);
    // 2 px (no shift): the vertical edges cover [19, 21) and [99, 101).
    expect(R.borderLines(box, 2)[0]).toEqual({ coordinates: [{ x: 19, y: 10 }, { x: 101, y: 10 }] });
    // 3 px: [19, 22) … [99, 102).
    expect(R.borderLines(box, 3)[1]).toEqual({ coordinates: [{ x: 19, y: 80 }, { x: 102, y: 80 }] });
  });

  it('handles sit on the corners and exactly halfway along each edge', () => {
    const box = { left: 20, top: 10, right: 100, bottom: 80 };
    const c = R.handleCoordinates({ x: 20, y: 80 }, { x: 100, y: 10 }, box);
    expect(c).toEqual([
      { x: 20, y: 80 }, { x: 100, y: 10 }, { x: 20, y: 10 }, { x: 100, y: 80 },
      { x: 20, y: 45 }, { x: 100, y: 45 }, { x: 60, y: 80 }, { x: 60, y: 10 },
    ]);
  });
});

describe('small and collapsed boxes', () => {
  it('a side shorter than the minimum span hides the two midpoints along it (the corners win)', () => {
    const a = { x: 20, y: 80 };
    const b = { x: 50, y: 10 }; // 30 wide, 70 tall
    const c = R.handleCoordinates(a, b, R.rectangleBox(a, b), 36);
    expect(c.slice(0, 4)).toEqual([a, b, { x: 20, y: 10 }, { x: 50, y: 80 }]);
    expect(c.slice(4, 6)).toEqual([{ x: 20, y: 45 }, { x: 50, y: 45 }]); // tall enough: vertical edges keep theirs
    expect(c.slice(6)).toEqual([R.HIDDEN_HANDLE, R.HIDDEN_HANDLE]); // too narrow: the horizontal edges' are parked
    const tiny = R.handleCoordinates(a, { x: 30, y: 70 }, R.rectangleBox(a, { x: 30, y: 70 }), 36);
    expect(tiny.slice(4)).toEqual(Array(4).fill(R.HIDDEN_HANDLE));
    // The parked position is far off any pane.
    expect(R.HIDDEN_HANDLE.x).toBeLessThan(-1000);
  });

  it('degenerate: zero width or height on whole pixels', () => {
    expect(R.isDegenerateBox({ x: 10.2, y: 5 }, { x: 9.9, y: 50 })).toBe(true);
    expect(R.isDegenerateBox({ x: 10, y: 5.1 }, { x: 90, y: 4.8 })).toBe(true);
    expect(R.isDegenerateBox({ x: 10, y: 5 }, { x: 11, y: 6 })).toBe(false);
  });

  it('a collapsed box (another timeframe) keeps a border with length, so it stays grabbable', () => {
    const lines = R.borderLines(R.rectangleBox({ x: 40, y: 10 }, { x: 40, y: 90 }), 1);
    const len = (l: { coordinates: Array<{ x: number; y: number }> }) =>
      Math.hypot(l.coordinates[1]!.x - l.coordinates[0]!.x, l.coordinates[1]!.y - l.coordinates[0]!.y);
    expect(lines.map(len)).toEqual([1, 1, 80, 80]);
    const point = R.borderLines(R.rectangleBox({ x: 40, y: 10 }, { x: 40, y: 10 }), 2);
    expect(len(point[0]!)).toBe(2);
  });
});

describe('rectangle fill', () => {
  beforeEach(() => {
    T.drawingContext.theme = 'dark';
    T.drawingContext.bg = THEME_TOKENS.dark.bg;
    T.drawingContext.accent = THEME_TOKENS.dark.accent;
  });

  it('is a hue-locked tint of the border color on the chart background, per theme, never an rgba() of the strong color', () => {
    expect(R.rectangleFill('#ff0000')).toBe(zoneTint('#ff0000', THEME_TOKENS.dark.bg, R.RECT_FILL_WEIGHT.dark, R.RECT_FILL_ALPHA));
    expect(R.rectangleFill('#ff0000')).not.toMatch(/^rgba\(255, 0, 0,/);
    T.drawingContext.theme = 'light';
    T.drawingContext.bg = THEME_TOKENS.light.bg;
    T.drawingContext.accent = THEME_TOKENS.light.accent;
    expect(R.rectangleFill('#ff0000')).toBe(zoneTint('#ff0000', THEME_TOKENS.light.bg, R.RECT_FILL_WEIGHT.light, R.RECT_FILL_ALPHA));
    // Unreadable color: the accent's tint.
    expect(R.rectangleFill('nonsense')).toBe(zoneTint(THEME_TOKENS.light.accent, THEME_TOKENS.light.bg, R.RECT_FILL_WEIGHT.light, R.RECT_FILL_ALPHA));
  });

  it('weights: balanced per theme (the dark ground needs more), firmer than the channel fill, below position zones', () => {
    expect(R.RECT_FILL_WEIGHT.dark).toBeGreaterThan(R.RECT_FILL_WEIGHT.light);
    for (const t of ['dark', 'light'] as const) {
      expect(R.RECT_FILL_WEIGHT[t]).toBeGreaterThan(T.CHANNEL_FILL_WEIGHT[t]); // a touch firmer than a channel on both themes
      expect(R.RECT_FILL_WEIGHT[t]).toBeLessThan(ZONE_WEIGHT);
    }
    expect(R.RECT_FILL_ALPHA).toBeLessThanOrEqual(0.14);
  });

  it('fill option: on by default, off when the styles say so', () => {
    expect(T.fillOption('rectangle', null)).toBe(true);
    expect(T.fillOption('rectangle', { [T.FILL_STYLE_KEY]: false })).toBe(false);
    expect(T.fillOption('rectangle', { [T.FILL_STYLE_KEY]: 'no' })).toBe(true);
    expect(T.fillOption('segment', { [T.FILL_STYLE_KEY]: false })).toBeNull();
  });
});

describe('rectangle template', () => {
  R.registerRectangleOverlay(true);
  const t = k.templates.get('rectangle')!;
  const chart = () => ({ getStyles: () => ({ overlay: { line: { color: 'rgba(41, 98, 255, 1)', size: 1, style: 'solid' } } }) });
  const bounding = { width: 400, height: 300, left: 0, top: 0, right: 0, bottom: 0 };

  it('is drawn with two clicks and shows its handles', () => {
    expect(t.name).toBe('rectangle');
    expect(t.totalStep).toBe(3);
    expect(t.needDefaultPointFigure).toBe(true);
    expect(t.needDefaultXAxisFigure).toBe(false); // our range labels instead (axisRange)
    expect(typeof t.createXAxisFigures).toBe('function');
    expect(t.needDefaultYAxisFigure).toBe(true);
  });

  it('while placing the second corner, the other handles follow; KLineChart drags resize through the rules', () => {
    const points: P[] = [{ ...A }, { ...B }];
    t.performEventMoveForDrawing({ points, performPointIndex: 1, performPoint: points[1], currentStep: 2, mode: 'normal' });
    expect(tv(points)).toEqual(tv(R.rectanglePoints(A, B)));
    const first: P[] = [{ ...A }];
    t.performEventMoveForDrawing({ points: first, performPointIndex: 0, performPoint: first[0], currentStep: 1, mode: 'normal' });
    expect(first).toHaveLength(1);
    points[6] = { timestamp: 1, value: 2 };
    t.performEventPressedMove({ points, performPointIndex: 6, performPoint: points[6], currentStep: -1, mode: 'normal' });
    expect(tv(points.slice(0, 2))).toEqual([[1000, 2], [5000, 30]]);
  });

  it('figures: a fill (under the border, right click ignored) and the border; handles moved to the edge midpoints', () => {
    const coordinates = [
      { x: 20.3, y: 80.2 }, { x: 100.2, y: 10.4 }, { x: 20.3, y: 10.4 }, { x: 100.2, y: 80.2 },
      { x: 20.3, y: 80.2 }, { x: 100.2, y: 10.4 }, { x: 20.3, y: 80.2 }, { x: 100.2, y: 10.4 },
    ];
    const overlay = { name: 'rectangle', points: R.rectanglePoints(A, B), styles: { line: { color: '#ff0000', size: 1, style: 'solid' } } };
    const figs: Fig[] = t.createPointFigures({ chart: chart(), overlay, coordinates, bounding });
    expect(figs.map((f) => f.type)).toEqual(['rect', 'line']);
    expect(figs[0]!.attrs).toEqual({ x: 20, y: 10, width: 80, height: 70 });
    expect(figs[0]!.styles).toMatchObject({ style: 'fill', color: R.rectangleFill('#ff0000') });
    expect(figs[0]!.ignoreEvent).toEqual(['onRightClick']);
    expect(figs[1]!.attrs).toEqual(R.borderLines({ left: 20, top: 10, right: 100, bottom: 80 }, 1));
    // The handles KLineChart draws next (same coordinates array): exactly halfway along the edges.
    expect(coordinates.slice(4)).toEqual([{ x: 20.3, y: 45 }, { x: 100.2, y: 45 }, { x: 60, y: 80.2 }, { x: 60, y: 10.4 }]);
  });

  it('fill off: the border only; the default drawing color when it has none of its own', () => {
    const coordinates = [{ x: 0, y: 0 }, { x: 50, y: 50 }];
    const off: Fig[] = t.createPointFigures({
      chart: chart(), overlay: { name: 'rectangle', points: [A, B], styles: { [T.FILL_STYLE_KEY]: false } }, coordinates, bounding,
    });
    expect(off.map((f) => f.type)).toEqual(['line']);
    const plain: Fig[] = t.createPointFigures({ chart: chart(), overlay: { name: 'rectangle', points: [A, B], styles: null }, coordinates, bounding });
    expect(plain[0]!.styles.color).toBe(R.rectangleFill('rgba(41, 98, 255, 1)'));
  });

  it('only the first corner placed: nothing drawn yet', () => {
    expect(t.createPointFigures({ chart: chart(), overlay: { name: 'rectangle', points: [A], styles: null }, coordinates: [{ x: 1, y: 1 }], bounding })).toEqual([]);
  });

  it('small box: midpoint handles hidden below three handle diameters (from the point style, a locked ring included)', () => {
    const withPoint = (point: object) => ({ getStyles: () => ({ overlay: { line: { size: 1 }, point } }) });
    const coords = () => [
      { x: 0, y: 0 }, { x: 40, y: 100 }, { x: 0, y: 100 }, { x: 40, y: 0 },
      { x: 0, y: 0 }, { x: 40, y: 100 }, { x: 0, y: 0 }, { x: 40, y: 100 },
    ];
    const big = coords(); // 40 wide ≥ 3 × 2 × (5 + 1) = 36: midpoints shown
    t.createPointFigures({ chart: withPoint({ radius: 5, borderSize: 1 }), overlay: { name: 'rectangle', points: [A, B], styles: null }, coordinates: big, bounding });
    expect(big[6]).toEqual({ x: 20, y: 0 });
    const ringed = coords(); // own (locked) ring 4.5 + 1.5 → still 36
    t.createPointFigures({ chart: withPoint({ radius: 8, borderSize: 1 }), overlay: { name: 'rectangle', points: [A, B], styles: { point: { radius: 4.5, borderSize: 1.5 } } }, coordinates: ringed, bounding });
    expect(ringed[6]).toEqual({ x: 20, y: 0 });
    const bigHandles = coords(); // 2 × (8 + 1) × 3 = 54 > 40: hidden
    t.createPointFigures({ chart: withPoint({ radius: 8, borderSize: 1 }), overlay: { name: 'rectangle', points: [A, B], styles: null }, coordinates: bigHandles, bounding });
    expect(bigHandles.slice(6)).toEqual([R.HIDDEN_HANDLE, R.HIDDEN_HANDLE]);
    expect(bigHandles[4]).toEqual({ x: 0, y: 50 }); // 100 tall: the vertical edges keep theirs
  });

  it('time axis: a band and the range labels, only while the rectangle is selected', () => {
    const p = {
      chart: { getStyles: () => ({ overlay: { text: { size: 12, paddingLeft: 4, paddingRight: 4 } } }), getFormatter: () => ({ formatDate: ({ timestamp }: { timestamp: number }) => `T${timestamp}` }) },
      overlay: { id: 'r1', name: 'rectangle', points: R.rectanglePoints(A, B), styles: null },
      coordinates: [{ x: 100, y: 0 }, { x: 400, y: 0 }], bounding: { width: 800, height: 24, left: 0, top: 0, right: 0, bottom: 0 },
    };
    T.drawingContext.selectedId = null;
    expect(t.createXAxisFigures(p)).toEqual([]);
    T.drawingContext.selectedId = 'r1';
    try {
      const figs: Fig[] = t.createXAxisFigures(p);
      expect(figs[0]).toMatchObject({ type: 'rect', attrs: { x: 100, y: 0, width: 300, height: 24 } });
      expect(figs.slice(1).map((f) => f.attrs)).toEqual([
        { x: 100, y: 0, text: 'T1000', align: 'right' },
        { x: 400, y: 0, text: 'T5000', align: 'left' },
      ]);
    } finally {
      T.drawingContext.selectedId = null;
    }
  });
});

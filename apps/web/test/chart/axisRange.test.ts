import { describe, expect, it } from 'vitest';
import { mergeRangeText, rangeLabels, RANGE_MERGE_GAP, tickMasks } from '../../src/chart/axisRange';

/** 10 px per character: easy widths. */
const measure = (s: string) => s.length * 10;
const W = 1000;

describe('time-axis range labels', () => {
  it('the left label ends at the left time, the right one starts at the right time (whichever is given first)', () => {
    expect(rangeLabels({ x0: 600, x1: 300, start: 'BBBB', end: 'AAAA', width: W, measure })).toEqual([
      { x: 300, text: 'AAAA', align: 'right' },
      { x: 600, text: 'BBBB', align: 'left' },
    ]);
  });

  it('clamps each label inside the axis', () => {
    // Left label would start at -20: it is pushed right so it starts at 0 (ends at its width).
    expect(rangeLabels({ x0: 20, x1: 500, start: 'AAAA', end: 'BBBB', width: W, measure })).toEqual([
      { x: 40, text: 'AAAA', align: 'right' },
      { x: 500, text: 'BBBB', align: 'left' },
    ]);
    // Right label would end at 1010: it starts at 960 instead.
    expect(rangeLabels({ x0: 400, x1: 970, start: 'AAAA', end: 'BBBB', width: W, measure })[1]).toEqual({ x: 960, text: 'BBBB', align: 'left' });
    // Both times past the right edge: both clamp to the edge, collide, and merge into one pill ending at the edge.
    expect(rangeLabels({ x0: 1200, x1: 1600, start: 'AA', end: 'BB', width: W, measure })).toEqual([{ x: 965, text: 'AA – BB', align: 'center' }]);
  });

  it('merges colliding labels into one centered "start – end" pill, kept inside the axis', () => {
    // Clamped at the right edge, the right label runs into the left one.
    const near = rangeLabels({ x0: 950, x1: 990, start: 'AAAA', end: 'BBBB', width: W, measure });
    expect(near).toEqual([{ x: 1000 - 55, text: 'AAAA – BBBB', align: 'center' }]);
    // Closer than the merge gap (no clamping involved): one pill centered on the range.
    const close = rangeLabels({ x0: 500, x1: 500 + RANGE_MERGE_GAP - 1, start: 'AAAA', end: 'BBBB', width: W, measure });
    expect(close).toEqual([{ x: 500 + (RANGE_MERGE_GAP - 1) / 2, text: 'AAAA – BBBB', align: 'center' }]);
    // Far enough apart: two labels.
    expect(rangeLabels({ x0: 500, x1: 500 + RANGE_MERGE_GAP, start: 'AAAA', end: 'BBBB', width: W, measure })).toHaveLength(2);
    // At the left edge the pill is clamped too.
    expect(rangeLabels({ x0: 0, x1: 4, start: 'AAAA', end: 'BBBB', width: W, measure })).toEqual([{ x: 55, text: 'AAAA – BBBB', align: 'center' }]);
  });

  it('one label for one time', () => {
    expect(rangeLabels({ x0: 500, x1: 500, start: 'AAAA', end: 'AAAA', width: W, measure })).toEqual([{ x: 500, text: 'AAAA', align: 'center' }]);
  });

  it('merged text drops the repeated date of an intraday range', () => {
    expect(mergeRangeText("Thu Oct 15 '26 · 07:15", "Thu Oct 15 '26 · 09:30")).toBe("Thu Oct 15 '26 · 07:15 – 09:30");
    expect(mergeRangeText("Thu Oct 15 '26 · 07:15", "Fri Oct 16 '26 · 09:30")).toBe("Thu Oct 15 '26 · 07:15 – Fri Oct 16 '26 · 09:30");
    expect(mergeRangeText("Thu Oct 15 '26", "Fri Oct 16 '26")).toBe("Thu Oct 15 '26 – Fri Oct 16 '26");
  });
});

describe('tickMasks: time-axis tick labels a range label would partly cover are masked whole', () => {
  const labels = [{ x: 300, text: 'AAAA', align: 'right' as const }, { x: 600, text: 'BBBB', align: 'left' as const }];
  // Label boxes: [260, 300] and [600, 640]; tick text boxes: coord ± length × 5.
  it('masks each tick whose text overlaps a label (with a little air), and nothing else', () => {
    const ticks = [{ coord: 250, text: 'Mar' }, { coord: 320, text: 'Apr' }, { coord: 450, text: 'May' }, { coord: 655, text: 'Jul' }, { coord: 700, text: 'Aug' }];
    expect(tickMasks(labels, ticks, measure)).toEqual([
      { x: 233, width: 34 }, // Mar: [235, 265] overlaps [260, 300]; masked with 2 px to spare on each side
      { x: 303, width: 34 }, // Apr: [305, 335] is 5 px from the label: within the 6 px of air, masked too
      { x: 638, width: 34 }, // Jul: [640, 670] touches [600, 640]
    ]);
  });
  it('a centered (merged) label', () => {
    expect(tickMasks([{ x: 500, text: 'AA – BB', align: 'center' }], [{ coord: 540, text: 'Jun' }, { coord: 600, text: 'Jul' }], measure))
      .toEqual([{ x: 523, width: 34 }]);
  });
});

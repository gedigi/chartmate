// Tests for the port of 'Wyckoff Accumulation Distribution' by faytterro (MPL-2.0, https://mozilla.org/MPL/2.0/).
import { describe, expect, it } from 'vitest';
import { pineRsi, pivotHigh, pivotLow, wyckoff, type WyckoffBar } from '../../src/chart/indicators/wyckoffCalc';

describe('pineRsi (ta.rsi: Wilder RMA seeded with the SMA)', () => {
  // Wilder's / StockCharts' classic 14-period RSI worksheet (cs-rsi.xls).
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328,
    45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
    45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
  ];
  const reference = [
    70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46,
    37.3, 33.08, 37.77,
  ];

  it('is na before index rsiLen and matches the reference sequence after', () => {
    const rsi = pineRsi(closes, 14);
    expect(rsi).toHaveLength(closes.length);
    for (let i = 0; i < 14; i++) expect(Number.isNaN(rsi[i]!), `index ${i}`).toBe(true);
    reference.forEach((v, k) => expect(rsi[14 + k]!, `index ${14 + k}`).toBeCloseTo(v, 2));
  });

  it('hand-computed 2-period case, including the down == 0 → 100 and up == 0 → 0 rules', () => {
    // changes: +2, -1, +3, 0, -4
    const rsi = pineRsi([10, 12, 11, 14, 14, 10], 2);
    expect(Number.isNaN(rsi[0]!)).toBe(true);
    expect(Number.isNaN(rsi[1]!)).toBe(true);
    // seed: up = (2+0)/2 = 1, down = (0+1)/2 = 0.5 → rs 2 → 66.666…
    expect(rsi[2]).toBeCloseTo(200 / 3, 10);
    // up = (1+3)/2 = 2, down = 0.25 → rs 8 → 88.888…
    expect(rsi[3]).toBeCloseTo(800 / 9, 10);
    // up = 1, down = 0.125 → 88.888…
    expect(rsi[4]).toBeCloseTo(800 / 9, 10);
    // up = 0.5, down = 2.0625 → 100 − 100/(1 + 0.5/2.0625)
    expect(rsi[5]).toBeCloseTo(100 - 100 / (1 + 0.5 / 2.0625), 10);
    expect(pineRsi([1, 2, 3, 4], 2).slice(2)).toEqual([100, 100]);
    expect(pineRsi([4, 3, 2, 1], 2).slice(2)).toEqual([0, 0]);
    expect(pineRsi([4, 4, 4], 2)[2]).toBe(100); // down == 0 is checked first
  });

  it('returns all-na when there are not enough bars', () => {
    expect(pineRsi([1, 2], 2).every(Number.isNaN)).toBe(true);
    expect(pineRsi([], 14)).toEqual([]);
  });
});

describe('pivotHigh / pivotLow (ta.pivothigh/ta.pivotlow(len, len))', () => {
  it('reports the pivot value on the confirmation bar (len bars after the pivot), na elsewhere', () => {
    const highs = [1, 2, 5, 3, 2, 4, 1];
    const ph = pivotHigh(highs, 2, 2);
    expect(ph.map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, null, null, 5, null, null]);
    const lows = [5, 4, 1, 3, 4, 2, 6];
    const pl = pivotLow(lows, 2, 2);
    expect(pl.map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, null, null, 1, null, null]);
  });

  it('needs a full window (no pivot in the first 2·len bars)', () => {
    expect(pivotHigh([9, 1, 1, 1, 1], 2, 2).every(Number.isNaN)).toBe(true);
  });

  it('ties: equal to an older (left) bar still pivots; equal to a newer (right) bar does not', () => {
    // flat top 5,5: the NEWER of the two is the pivot (left tie allowed, right tie rejected)
    const ph = pivotHigh([1, 5, 5, 2, 1], 1, 1);
    expect(Number.isNaN(ph[2]!)).toBe(true); // center index 1 has an equal newer neighbor
    expect(ph[3]).toBe(5); // center index 2 ties only with the older neighbor
    const pl = pivotLow([9, 2, 2, 7, 9], 1, 1);
    expect(Number.isNaN(pl[2]!)).toBe(true);
    expect(pl[3]).toBe(2);
  });
});

// All scenarios: RSI length 2, sensitivity 20 (side band 30 < RSI < 70), pivot length 1.
const P = { rsiLen: 2, sens: 20, pivotLen: 1 };
const fromCloses = (closes: number[], pad = 0.5): WyckoffBar[] => closes.map((c) => ({ close: c, high: c + pad, low: c - pad }));
const fromHlc = (rows: Array<[number, number, number]>): WyckoffBar[] => rows.map(([close, high, low]) => ({ close, high, low }));
/** Mirror image (price → 40 − price): RSI → 100 − RSI, highs ↔ lows, bull ↔ bear, SC ↔ BC, AR ↔ DAR. */
const mirror = (bars: WyckoffBar[]): WyckoffBar[] => bars.map((b) => ({ close: 40 - b.close, high: 40 - b.low, low: 40 - b.high }));
const kinds = (r: ReturnType<typeof wyckoff>) => r.signals.map((s) => [s.index, s.kind]);

describe('wyckoff: side → trend boxes and barcolor', () => {
  // RSI: 2:50 3:75 4:37.5 5:68.8 6:34.4 7:78.1 8:90.6 9:95.6 10:97.9 11:99.0 12:65.6 …
  // side (RSI or RSI[1] in the band) on 2…7; 8 is the first non-side bar → box from x1 = 2 to x2 = 8 − 2 = 6.
  const accumulation = fromCloses([10, 11, 10, 11, 10, 11, 10, 12, 14, 16, 18, 20, 19, 20, 19, 20, 19, 20]);

  it('side → bull: one box over bars 2…6 (high/low of that range), recolored "Accumulation"', () => {
    const r = wyckoff(accumulation, P);
    expect(r.boxes).toEqual([{ left: 2, right: 6, top: 11.5, bottom: 9.5, kind: 'accumulation', filled: true, text: 'Accumulation' }]);
  });

  it('barcolor is applied two bars back: bull on bars 8…11 marks bars 6…9 bull', () => {
    const r = wyckoff(accumulation, P);
    expect(r.barTrends.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)).toEqual([6, 7, 8, 9]);
    expect(r.barTrends[6]).toBe('bull');
  });

  it('side → bear (mirror image): "Distribution" box and bear bars', () => {
    const r = wyckoff(mirror(accumulation), P);
    expect(r.boxes).toEqual([{ left: 2, right: 6, top: 30.5, bottom: 28.5, kind: 'distribution', filled: true, text: 'Distribution' }]);
    expect(r.barTrends.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)).toEqual([6, 7, 8, 9]);
    expect(r.barTrends[6]).toBe('bear');
  });

  it('range background only when x1 < x2; none when x1 == x2 (two-bar side run)', () => {
    // RSI 2:50 3:90 4:21.4 → side on 2, 3; box at bar 4 with x1 = 2, x2 = 2; 90 → 21 is neither bull nor bear.
    const r = wyckoff(fromCloses([10, 11, 10, 14, 6]), P);
    expect(r.boxes).toEqual([{ left: 2, right: 2, top: 10.5, bottom: 9.5, kind: 'range', filled: false, text: null }]);
  });

  it('after_trend recolors only the most recent box, every bar', () => {
    // RSI 2:50 3:66.7 4:47.6 5:93.6 6:19.9 7:68.9 8:31 9:27.2 10:21.9 11:15.8 12:10.1 13:33.9 14:22.2 15:54
    //     16:29.7 17:63 18:90.4 19:96.8 20:98.6 21:99.3
    const r = wyckoff(fromCloses([10, 11, 10, 10.5, 10.2, 14, 6, 14, 6, 5, 4, 3, 2, 2.5, 2, 2.5, 2, 2.5, 4, 6, 8, 10]), P);
    expect(r.boxes).toEqual([
      // created on bar 6 (93.6 → 19.9 is no trend): stays gray, it is no longer the latest box when the bear comes
      { left: 2, right: 4, top: 11, bottom: 9.5, kind: 'range', filled: true, text: null },
      // created on bar 10, which is also the first bear bar
      { left: 7, right: 8, top: 14.5, bottom: 5.5, kind: 'distribution', filled: true, text: 'Distribution' },
      // created on bar 19, the first bull bar after it
      { left: 13, right: 17, top: 3, bottom: 1.5, kind: 'accumulation', filled: true, text: 'Accumulation' },
    ]);
    expect(r.barTrends.map((c, i) => (c ? `${i}:${c}` : '')).filter(Boolean)).toEqual([
      `8:bear`, `9:bear`, `10:bear`, `17:bull`, `18:bull`, `19:bull`,
    ]);
  });

  it('keeps at most maxBoxes (oldest dropped)', () => {
    const closes = Array.from({ length: 60 }, (_, i) => [10, 11, 10, 14, 6][i % 5]!);
    const all = wyckoff(fromCloses(closes), P).boxes;
    expect(all.length).toBeGreaterThan(3);
    const capped = wyckoff(fromCloses(closes), P, { maxBoxes: 3 }).boxes;
    expect(capped).toEqual(all.slice(-3));
  });
});

describe('wyckoff: signals (plotted on the pivot bar, offset −pivotLen)', () => {
  // RSI: 2:0 3:0 4:0 5:51.2 6:74.7 7:50.4 8:30.5 9:64.3 10:73
  const climax = fromHlc([
    [20, 20.5, 19.5], [18, 18.5, 17.5], [16, 16.5, 15.5], [14, 14.5, 13.5], [13.9, 14.2, 13.6],
    [15, 15.5, 14.5], [16, 17, 15.5], [15.5, 16, 15], [15, 15.5, 14.8], [15.6, 16, 15.2], [15.8, 16.1, 15.4],
  ]);

  it('SC at the RSI<30 pivot low, AR at the next pivot high, ST at the next pivot low', () => {
    // pivot low 3 (RSI 0 < 30, confirmed on bar 4 where RSI is still 0 → no spring) = SC;
    // pivot high 6 (6 > 3) = AR; the counter is reset on bars 4, 5 (RSI[1] < 30), pivot low 8 counts 1 = ST.
    const r = wyckoff(climax, P);
    expect(kinds(r)).toEqual([[3, 'SC'], [6, 'AR'], [8, 'ST']]);
    expect(r.signals.map((s) => [s.text, s.position, s.tone])).toEqual([
      ['SC', 'below', 'accumulation'], ['AR', 'above', 'accumulation'], ['ST', 'below', 'accumulation'],
    ]);
  });

  it('BC, AR (reaction), ST (distribution) on the mirror image', () => {
    const r = wyckoff(mirror(climax), P);
    expect(kinds(r)).toEqual([[3, 'BC'], [6, 'DAR'], [8, 'DST']]);
    expect(r.signals.map((s) => [s.text, s.position, s.tone])).toEqual([
      ['BC', 'above', 'distribution'], ['AR', 'below', 'distribution'], ['ST', 'above', 'distribution'],
    ]);
  });

  it('a spring on the confirmation bar suppresses the SC (and so the AR)', () => {
    const bars = climax.map((b) => ({ ...b }));
    bars[4] = { close: 16, high: 16.2, low: 13.6 }; // big up close: RSI 4 > 30 while RSI 3 < 30 → spring
    const r = wyckoff(bars, P);
    expect(r.signals.some((s) => s.kind === 'SC' || s.kind === 'AR')).toBe(false);
    expect(kinds(r)).toContainEqual([3, 'PIVOT_LOW']);
  });

  it('unlabeled pivots are neutral (pivot-tone) triangles on the pivot bar', () => {
    const r = wyckoff(fromCloses([10, 11, 10, 11, 10, 11, 10, 12, 14, 16, 18, 20, 19, 20, 19, 20, 19, 20]), P);
    expect(kinds(r)).toEqual([
      [1, 'PIVOT_HIGH'], [2, 'ST'], [3, 'PIVOT_HIGH'], [4, 'PIVOT_LOW'], [5, 'PIVOT_HIGH'], [6, 'PIVOT_LOW'],
      [11, 'PIVOT_HIGH'], [12, 'PIVOT_LOW'], [13, 'PIVOT_HIGH'], [14, 'PIVOT_LOW'], [15, 'PIVOT_HIGH'], [16, 'PIVOT_LOW'],
    ]);
    const orange = r.signals.find((s) => s.kind === 'PIVOT_LOW')!;
    expect(orange).toMatchObject({ text: '', position: 'below', tone: 'pivot' });
  });
});

describe('wyckoff: calc_bars_count and edge cases', () => {
  it('only the last calcBarsCount bars are calculated; earlier bars produce nothing', () => {
    const climax = fromHlc([
      [20, 20.5, 19.5], [18, 18.5, 17.5], [16, 16.5, 15.5], [14, 14.5, 13.5], [13.9, 14.2, 13.6],
      [15, 15.5, 14.5], [16, 17, 15.5], [15.5, 16, 15], [15, 15.5, 14.8], [15.6, 16, 15.2], [15.8, 16.1, 15.4],
    ]);
    const junk = fromCloses([50, 10, 60, 5, 70, 1, 80]);
    const r = wyckoff([...junk, ...climax], P, { calcBarsCount: climax.length });
    expect(r.signals.map((s) => [s.index - junk.length, s.kind])).toEqual([[3, 'SC'], [6, 'AR'], [8, 'ST']]);
    expect(r.rsi.slice(0, junk.length + 2).every(Number.isNaN)).toBe(true); // RSI restarts at the window
    expect(r.rsi[junk.length + 2]).toBe(0);
    expect(r.barTrends).toHaveLength(junk.length + climax.length);
  });

  it('defaults to the last 1000 bars', () => {
    const closes = Array.from({ length: 1010 }, (_, i) => 100 + 10 * Math.sin(i / 3));
    const r = wyckoff(fromCloses(closes), { rsiLen: 14, sens: 20, pivotLen: 5 });
    expect(r.rsi.slice(0, 10 + 14).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(r.rsi[10 + 14]!)).toBe(true);
    expect(r.signals.every((s) => s.index >= 10)).toBe(true);
    expect(r.boxes.every((b) => b.left >= 10)).toBe(true);
    expect(r.barTrends.slice(0, 10).every((c) => c === null)).toBe(true);
  });

  it('empty and very short inputs produce nothing', () => {
    expect(wyckoff([], P)).toEqual({ rsi: [], boxes: [], signals: [], barTrends: [] });
    const r = wyckoff(fromCloses([1, 2]), { rsiLen: 14, sens: 20, pivotLen: 5 });
    expect(r.boxes).toEqual([]);
    expect(r.signals).toEqual([]);
  });

  it('sensitivity 0: the side band is empty (no boxes), every RSI≠50 bar is a trend', () => {
    const r = wyckoff(fromCloses([10, 11, 10, 11, 10, 11, 10, 12, 14, 16]), { ...P, sens: 0 });
    expect(r.boxes).toEqual([]);
  });
});

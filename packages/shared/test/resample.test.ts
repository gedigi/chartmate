import { describe, it, expect } from 'vitest';
import { resample, bucketStart } from '../src/resample.js';
const H = 3_600_000;
const bar = (ts: number, o: number, h: number, l: number, c: number, v = 1, session?: any) => ({ ts, open: o, high: h, low: l, close: c, volume: v, session });

describe('bucketStart', () => {
  it('weekly → Monday UTC', () => {
    expect(bucketStart(Date.UTC(2026, 9, 9), '1W', 'utc')).toBe(Date.UTC(2026, 9, 5)); // Fri → Mon
    expect(bucketStart(Date.UTC(2026, 9, 11), '1W', 'utc')).toBe(Date.UTC(2026, 9, 5)); // Sun → prior Mon
    expect(bucketStart(Date.UTC(2026, 9, 12), '1W', 'utc')).toBe(Date.UTC(2026, 9, 12));
  });
  it('monthly → 1st', () => {
    expect(bucketStart(Date.UTC(2026, 9, 31), '1M', 'utc')).toBe(Date.UTC(2026, 9, 1));
  });
  it('utc intraday', () => {
    expect(bucketStart(Date.UTC(2026, 0, 1, 5, 59), '4h', 'utc')).toBe(Date.UTC(2026, 0, 1, 4));
  });
  it('nyse-rth anchors 09:30 NY (EDT and EST)', () => {
    expect(bucketStart(Date.UTC(2026, 6, 1, 14, 30), '2h', 'nyse-rth')).toBe(Date.UTC(2026, 6, 1, 13, 30));
    expect(bucketStart(Date.UTC(2026, 6, 1, 15, 30), '2h', 'nyse-rth')).toBe(Date.UTC(2026, 6, 1, 15, 30));
    expect(bucketStart(Date.UTC(2026, 0, 15, 15, 30), '2h', 'nyse-rth')).toBe(Date.UTC(2026, 0, 15, 14, 30));
  });
  it('nyse-rth 2h buckets across DST (EST 03-06, EDT 03-09)', () => {
    expect(bucketStart(Date.UTC(2026, 2, 6, 16, 0), '2h', 'nyse-rth')).toBe(Date.UTC(2026, 2, 6, 14, 30));
    expect(bucketStart(Date.UTC(2026, 2, 9, 15, 0), '2h', 'nyse-rth')).toBe(Date.UTC(2026, 2, 9, 13, 30));
    expect(bucketStart(Date.UTC(2026, 2, 9, 14, 0), '1D', 'nyse-rth')).toBe(Date.UTC(2026, 2, 9));
  });
  it('nyse-eth anchors 04:00 NY', () => {
    expect(bucketStart(Date.UTC(2026, 6, 1, 11, 0), '4h', 'nyse-eth')).toBe(Date.UTC(2026, 6, 1, 8, 0));
    expect(bucketStart(Date.UTC(2026, 6, 1, 12, 0), '4h', 'nyse-eth')).toBe(Date.UTC(2026, 6, 1, 12, 0));
  });
});

describe('resample', () => {
  it('aggregates OHLCV', () => {
    const t = Date.UTC(2026, 0, 1);
    const out = resample([bar(t, 10, 12, 9, 11, 5), bar(t + H, 11, 15, 10, 14, 7), bar(t + 2 * H, 14, 14, 13, 13, 1)], '2h', 'utc');
    expect(out).toEqual([
      { ts: t, open: 10, high: 15, low: 9, close: 14, volume: 12, session: undefined },
      { ts: t + 2 * H, open: 14, high: 14, low: 13, close: 13, volume: 1, session: undefined },
    ]);
  });
  it('keeps uniform session, clears mixed', () => {
    const t = Date.UTC(2026, 6, 1, 8);
    const out = resample([bar(t, 1, 1, 1, 1, 1, 'pre'), bar(t + H, 1, 1, 1, 1, 1, 'pre'), bar(t + 5.5 * H, 1, 1, 1, 1, 1, 'regular'), bar(t + 6 * H, 1, 1, 1, 1, 1, 'post')], '4h', 'nyse-eth');
    expect(out.map(b => b.session)).toEqual(['pre', undefined]);
  });
  it('daily → weekly', () => {
    const d = (day: number, c: number) => bar(Date.UTC(2026, 9, day), c, c + 1, c - 1, c, 1);
    const out = resample([d(5, 1), d(6, 2), d(9, 5), d(12, 7)], '1W', 'utc');
    expect(out.map(b => [b.ts, b.open, b.close, b.high, b.low, b.volume])).toEqual([
      [Date.UTC(2026, 9, 5), 1, 5, 6, 0, 3],
      [Date.UTC(2026, 9, 12), 7, 7, 8, 6, 1],
    ]);
  });
  it('gaps produce separate buckets (no empty buckets filled in)', () => {
    const t = Date.UTC(2026, 0, 1);
    const out = resample([bar(t, 1, 2, 0, 1), bar(t + 5 * H, 3, 4, 2, 3), bar(t + 9 * H, 5, 6, 4, 5)], '2h', 'utc');
    expect(out.map(b => [b.ts, b.open, b.close])).toEqual([[t, 1, 1], [t + 4 * H, 3, 3], [t + 8 * H, 5, 5]]);
  });
  it('daily → monthly', () => {
    const d = (m: number, day: number, c: number) => bar(Date.UTC(2026, m, day), c, c + 1, c - 1, c, 2);
    const out = resample([d(0, 30, 1), d(1, 2, 2), d(1, 27, 3), d(2, 2, 4)], '1M', 'utc');
    expect(out.map(b => [b.ts, b.open, b.close, b.high, b.low, b.volume])).toEqual([
      [Date.UTC(2026, 0, 1), 1, 1, 2, 0, 2],
      [Date.UTC(2026, 1, 1), 2, 3, 4, 1, 4],
      [Date.UTC(2026, 2, 1), 4, 4, 5, 3, 2],
    ]);
  });
  it('nyse-rth 2h across the spring-forward weekend keeps 09:30 NY anchor on both sides', () => {
    const fri = Date.UTC(2026, 2, 6, 14, 30); // 09:30 EST
    const mon = Date.UTC(2026, 2, 9, 13, 30); // 09:30 EDT
    const bars = [0, 1, 2].flatMap((i) => [bar(fri + i * H, i, i, i, i), bar(mon + i * H, 10 + i, 10 + i, 10 + i, 10 + i)]).sort((a, b) => a.ts - b.ts);
    const out = resample(bars, '2h', 'nyse-rth');
    expect(out.map(b => [b.ts, b.open, b.close])).toEqual([
      [fri, 0, 1], [fri + 2 * H, 2, 2], [mon, 10, 11], [mon + 2 * H, 12, 12],
    ]);
  });
  it('nyse-eth 4h on the fall-back day (2026-11-02 Monday after) anchors 04:00 EST', () => {
    const a = Date.UTC(2026, 10, 2, 9, 0); // 04:00 EST
    const out = resample([bar(Date.UTC(2026, 9, 30, 8, 0), 1, 1, 1, 1), bar(a, 2, 2, 2, 2), bar(a + 3 * H, 3, 3, 3, 3)], '4h', 'nyse-eth');
    expect(out.map(b => [b.ts, b.close])).toEqual([[Date.UTC(2026, 9, 30, 8, 0), 1], [a, 3]]);
  });
  it('unsorted input is sorted defensively (stable) and equal ts are deduped (last wins)', () => {
    const t = Date.UTC(2026, 0, 1);
    const out = resample([
      bar(t + H, 20, 21, 19, 20, 1),
      bar(t, 10, 11, 9, 10, 1),
      bar(t + H, 30, 31, 29, 30, 5), // duplicate ts: this one wins
      bar(t + 2 * H, 40, 41, 39, 40, 1),
    ], '2h', 'utc');
    expect(out.map(b => [b.ts, b.open, b.high, b.low, b.close, b.volume])).toEqual([
      [t, 10, 31, 9, 30, 6],
      [t + 2 * H, 40, 41, 39, 40, 1],
    ]);
  });
  it('does not mutate the input array', () => {
    const t = Date.UTC(2026, 0, 1);
    const input = [bar(t + H, 2, 2, 2, 2), bar(t, 1, 1, 1, 1)];
    resample(input, '2h', 'utc');
    expect(input.map(b => b.ts)).toEqual([t + H, t]);
  });
  it('empty', () => { expect(resample([], '4h', 'utc')).toEqual([]); });
});

describe('resample on the NYSE calendars: per-day memoization', () => {
  const MIN = 60_000;
  // Every 7 minutes over 10 days around each DST transition of 2025 and 2026, weekends included.
  const span = [Date.UTC(2025, 2, 4), Date.UTC(2025, 9, 28), Date.UTC(2026, 2, 3), Date.UTC(2026, 9, 27)]
    .flatMap((from) => Array.from({ length: (10 * 24 * 60) / 7 }, (_, i) => from + i * 7 * MIN));

  it('matches bucketStart for every bar, across DST transitions and in any input order', () => {
    const bars = span.map((ts, i) => bar(ts, i, i, i, i));
    for (const tf of ['30m', '2h', '4h'] as const) {
      for (const cal of ['nyse-rth', 'nyse-eth'] as const) {
        const want = [...new Set(span.map((ts) => bucketStart(ts, tf, cal)))];
        expect(resample(bars, tf, cal).map((b) => b.ts), `${tf} ${cal}`).toEqual(want);
      }
    }
    const some = bars.slice(0, 3000);
    expect(resample(some.slice().reverse(), '2h', 'nyse-eth')).toEqual(resample(some, '2h', 'nyse-eth'));
  });

  it('perf: 2h nyse-eth over ~11k hourly bars is far cheaper than one time-zone lookup per bar', () => {
    // 16 extended-hours 1h bars per weekday, ~2.7 years: about 11.4k bars.
    const bars: ReturnType<typeof bar>[] = [];
    for (let d = Date.UTC(2024, 0, 1); bars.length < 11_400; d += 24 * H) {
      const dow = new Date(d).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (let h = 0; h < 16; h++) bars.push(bar(d + 9 * H + h * H, 1, 2, 0, 1));
    }
    // Best of 3 runs, so a GC pause or a busy CPU during one run can't fail the comparison below.
    let ms = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      resample(bars, '2h', 'nyse-eth');
      ms = Math.min(ms, performance.now() - t0);
    }
    // Baseline on the same machine (the unmemoized per-bar lookup), so a slow CI runner can't make this flaky.
    let baseline = Infinity;
    for (let run = 0; run < 2; run++) {
      const t1 = performance.now();
      for (const b of bars) bucketStart(b.ts, '2h', 'nyse-eth');
      baseline = Math.min(baseline, performance.now() - t1);
    }
    expect(ms).toBeLessThan(baseline / 3);
  });
});

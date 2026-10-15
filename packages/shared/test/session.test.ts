import { describe, it, expect } from 'vitest';
import { tagSessionFixedHours, tagSessions, filterSession } from '../src/session.js';
const b = (ts: number, session?: any) => ({ ts, open: 1, high: 1, low: 1, close: 1, volume: 1, session });

describe('session tagging', () => {
  it('fixed hours EDT', () => {
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 1, 8, 0))).toBe('pre');      // 04:00 NY
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 1, 13, 29))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 1, 13, 30))).toBe('regular');
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 1, 20, 0))).toBe('post');     // 16:00 NY
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 2, 0, 0))).toBeNull();       // 20:00 NY
  });
  it('fixed hours EST (after fall-back)', () => {
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 2, 14, 29))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 2, 14, 30))).toBe('regular');
  });
  it('fixed hours: weekends (NY date) have no session', () => {
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 4, 14, 0))).toBeNull();      // Sat 10:00 EDT
    expect(tagSessionFixedHours(Date.UTC(2026, 6, 5, 21, 0))).toBeNull();      // Sun 17:00 EDT
    // The NY date decides, not the UTC one: Fri 19:30 EST is Saturday in UTC but still Friday's post-market.
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 7, 0, 30))).toBe('post');
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 9, 9, 0))).toBe('pre');      // Mon 04:00 EST
    expect(tagSessions([b(Date.UTC(2026, 6, 4, 14, 0)), b(Date.UTC(2026, 6, 6, 14, 0))]).map(x => x.session)).toEqual(['regular']);
  });
  it('windows override fixed hours (half day close 13:00)', () => {
    const day = Date.UTC(2026, 10, 27); // Fri after Thanksgiving, EST
    const windows = [
      { start: day + 14.5 * 3600e3, end: day + 18 * 3600e3, session: 'regular' as const },
      { start: day + 18 * 3600e3, end: day + 22 * 3600e3, session: 'post' as const },
    ];
    const out = tagSessions([b(day + 17 * 3600e3), b(day + 19 * 3600e3)], windows);
    expect(out.map(x => x.session)).toEqual(['regular', 'post']);
  });
  it('drops bars outside any session', () => {
    expect(tagSessions([b(Date.UTC(2026, 6, 2, 2, 0))])).toEqual([]);
  });
  it('filterSession', () => {
    const bars = [b(1, 'pre'), b(2, 'regular'), b(3, 'post'), b(4)];
    expect(filterSession(bars, 'rth').map(x => x.ts)).toEqual([2, 4]);
    expect(filterSession(bars, 'eth').map(x => x.ts)).toEqual([1, 2, 3, 4]);
  });
  it('first session after a DST transition: 04:00 NY is pre', () => {
    // Transitions fall on Sundays (no session): 2026-03-08 spring forward, so Mon 04:00 EDT = 08:00Z;
    // 2026-11-01 fall back, so Mon 04:00 EST = 09:00Z.
    expect(tagSessionFixedHours(Date.UTC(2026, 2, 8, 8, 0))).toBeNull();
    expect(tagSessionFixedHours(Date.UTC(2026, 2, 9, 8, 0))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 2, 9, 7, 59))).toBeNull();
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 2, 9, 0))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 2, 8, 59))).toBeNull();
  });
  it('does not mutate input', () => {
    const input = [b(Date.UTC(2026, 6, 1, 14, 0))];
    const out = tagSessions(input);
    expect(out[0]?.session).toBe('regular');
    expect(input[0]?.session).toBeUndefined();
  });
  it('overlapping windows: the first matching window (input order) wins', () => {
    const windows = [
      { start: 100, end: 200, session: 'post' as const },
      { start: 50, end: 150, session: 'regular' as const },
      { start: 0, end: 1000, session: 'pre' as const },
    ];
    const out = tagSessions([b(40), b(60), b(120), b(170), b(250), b(999)], windows);
    expect(out.map(x => [x.ts, x.session])).toEqual([
      [40, 'pre'], [60, 'regular'], [120, 'post'], [170, 'post'], [250, 'pre'], [999, 'pre'],
    ]);
  });
  it('window boundaries are [start, end); empty windows never match', () => {
    const t = Date.UTC(2026, 6, 2, 3, 0); // 23:00 NY: no fixed-hours session
    const windows = [
      { start: t, end: t, session: 'post' as const },
      { start: t + 10, end: t + 20, session: 'pre' as const },
    ];
    const out = tagSessions([b(t), b(t + 10), b(t + 19), b(t + 20)], windows);
    expect(out.map(x => [x.ts, x.session])).toEqual([[t + 10, 'pre'], [t + 19, 'pre']]);
  });
  it('unsorted windows behave like sorted ones', () => {
    const windows = [
      { start: 300, end: 400, session: 'post' as const },
      { start: 100, end: 200, session: 'pre' as const },
    ];
    expect(tagSessions([b(150), b(350)], windows).map(x => x.session)).toEqual(['pre', 'post']);
  });
  it('perf: 50k bars x 2k windows tags quickly (binary search, not a linear scan)', () => {
    const W = 2000, N = 50_000, span = 1000;
    const windows = Array.from({ length: W }, (_, i) => ({ start: i * span, end: (i + 1) * span, session: 'regular' as const }));
    // all bars fall in the last windows so a linear find scans nearly all of them
    const bars = Array.from({ length: N }, (_, i) => b((W - 1) * span + (i % span)));
    // Best of 3 runs, so a GC pause or a busy CPU during one run can't fail the comparison below.
    let ms = Infinity;
    let out: ReturnType<typeof tagSessions> = [];
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      out = tagSessions(bars, windows);
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(out).toHaveLength(N);
    // Compare with a linear scan timed on the same machine, so a slow or busy CI runner can't make this flaky.
    const t1 = performance.now();
    let hits = 0;
    for (const bar of bars) if (windows.find((w) => bar.ts >= w.start && bar.ts < w.end)) hits++;
    const linearMs = performance.now() - t1;
    expect(hits).toBe(N);
    expect(ms).toBeLessThan(linearMs / 4);
  });
});

describe('tagSessions without windows: per-day memoization', () => {
  const MIN = 60_000;
  it('matches tagSessionFixedHours for every bar, across DST transitions and in any input order', () => {
    // Every 7 minutes over 10 days around each DST transition of 2025 and 2026, weekends included.
    const ts = [Date.UTC(2025, 2, 4), Date.UTC(2025, 9, 28), Date.UTC(2026, 2, 3), Date.UTC(2026, 9, 27)]
      .flatMap((from) => Array.from({ length: (10 * 24 * 60) / 7 }, (_, i) => from + i * 7 * MIN));
    const want = ts.map((t) => [t, tagSessionFixedHours(t)] as const).filter(([, s]) => s !== null);
    expect(tagSessions(ts.map((t) => b(t))).map((x) => [x.ts, x.session])).toEqual(want);
    const rev = ts.slice(0, 5000).reverse();
    expect(tagSessions(rev.map((t) => b(t))).map((x) => x.ts)).toEqual(rev.filter((t) => tagSessionFixedHours(t) !== null));
  });

  it('perf: 30k 1m bars tag far faster than one time-zone lookup per bar', () => {
    const bars = Array.from({ length: 30_000 }, (_, i) => b(Date.UTC(2026, 6, 6, 8) + i * MIN));
    // Best of 3 runs, so a GC pause or a busy CPU during one run can't fail the comparison below.
    let ms = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      tagSessions(bars);
      ms = Math.min(ms, performance.now() - t0);
    }
    // Baseline on the same machine (the unmemoized per-bar lookup), so a slow CI runner can't make this flaky.
    let baseline = Infinity;
    for (let run = 0; run < 2; run++) {
      const t1 = performance.now();
      for (const bar of bars) tagSessionFixedHours(bar.ts);
      baseline = Math.min(baseline, performance.now() - t1);
    }
    expect(ms).toBeLessThan(baseline / 3);
  });
});

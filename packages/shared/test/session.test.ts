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
  it('DST transition days: 04:00 NY is pre', () => {
    // 2026-03-08 spring forward (04:00 EDT = 08:00Z); 2026-11-01 fall back (04:00 EST = 09:00Z)
    expect(tagSessionFixedHours(Date.UTC(2026, 2, 8, 8, 0))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 2, 8, 7, 59))).toBeNull();
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 1, 9, 0))).toBe('pre');
    expect(tagSessionFixedHours(Date.UTC(2026, 10, 1, 8, 59))).toBeNull();
  });
  it('does not mutate input', () => {
    const input = [b(Date.UTC(2026, 6, 1, 14, 0))];
    const out = tagSessions(input);
    expect(out[0]?.session).toBe('regular');
    expect(input[0]?.session).toBeUndefined();
  });
});

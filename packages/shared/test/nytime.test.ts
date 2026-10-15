import { describe, it, expect } from 'vitest';
import { nyParts, nyToUtc, nyDateUtcMidnight, utcDateString, parseDateString, nyDay, nyDayTime, memoByNyDay } from '../src/nytime.js';

describe('nytime', () => {
  it('EDT summer: 09:30 NY = 13:30Z', () => {
    expect(nyToUtc(2026, 7, 1, 9, 30)).toBe(Date.UTC(2026, 6, 1, 13, 30));
  });
  it('EST winter: 09:30 NY = 14:30Z', () => {
    expect(nyToUtc(2026, 1, 15, 9, 30)).toBe(Date.UTC(2026, 0, 15, 14, 30));
  });
  it('DST spring-forward day 2026-03-08: 09:30 is EDT', () => {
    expect(nyToUtc(2026, 3, 8, 9, 30)).toBe(Date.UTC(2026, 2, 8, 13, 30));
    expect(nyToUtc(2026, 3, 6, 9, 30)).toBe(Date.UTC(2026, 2, 6, 14, 30));
  });
  it('DST fall-back 2026-11-01', () => {
    expect(nyToUtc(2026, 11, 2, 9, 30)).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(nyToUtc(2026, 10, 30, 9, 30)).toBe(Date.UTC(2026, 9, 30, 13, 30));
  });
  it('nyParts decomposes a summer instant into NY wall-clock parts', () => {
    const p = nyParts(Date.UTC(2026, 6, 1, 13, 30));
    expect(p).toMatchObject({ y: 2026, m: 7, d: 1, hh: 9, mm: 30, dow: 3 });
  });
  it('DST transition days: early-hour (04:00) cases', () => {
    expect(nyToUtc(2026, 3, 8, 4, 0)).toBe(Date.UTC(2026, 2, 8, 8, 0));
    expect(nyToUtc(2026, 11, 1, 4, 0)).toBe(Date.UTC(2026, 10, 1, 9, 0));
  });
  it('nyParts(nyToUtc(...)) round-trips every valid minute-of-day on both transition days', () => {
    for (const [m, d] of [[3, 8], [11, 1]] as const) {
      for (let hh = 0; hh < 24; hh++) {
        for (const mm of [0, 15, 30, 59]) {
          // 02:xx on spring-forward day does not exist; skip it
          if (m === 3 && hh === 2) continue;
          const p = nyParts(nyToUtc(2026, m, d, hh, mm));
          expect(p).toMatchObject({ y: 2026, m, d, hh, mm });
        }
      }
    }
  });
  it('non-existent spring-gap time resolves forward by the gap (02:30 -> 03:30 EDT)', () => {
    // 2026-03-08 02:30 NY does not exist; interpreted with the pre-transition (EST) offset
    expect(nyToUtc(2026, 3, 8, 2, 30)).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(nyParts(nyToUtc(2026, 3, 8, 2, 0))).toMatchObject({ hh: 3, mm: 0 });
  });
  it('ambiguous fall-overlap time resolves to the earlier instant (EDT)', () => {
    expect(nyToUtc(2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(nyToUtc(2026, 11, 1, 1, 0)).toBe(Date.UTC(2026, 10, 1, 5, 0));
  });
  it('rejects out-of-range inputs with RangeError', () => {
    expect(() => nyToUtc(2026, 0, 1, 0, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 13, 1, 0, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 2, 29, 0, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 4, 31, 0, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 1, 0, 0, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 1, 1, 24, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 1, 1, -1, 0)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 1, 1, 0, 60)).toThrow(RangeError);
    expect(() => nyToUtc(2026, 1, 1, 0, 1.5)).toThrow(RangeError);
    expect(nyToUtc(2028, 2, 29, 0, 0)).toBe(Date.UTC(2028, 1, 29, 5, 0));
  });
  it('nyDateUtcMidnight uses NY date (late evening UTC next day)', () => {
    expect(nyDateUtcMidnight(Date.UTC(2026, 6, 2, 3, 30))).toBe(Date.UTC(2026, 6, 1));
  });
  it('date strings', () => {
    expect(utcDateString(Date.UTC(2024, 0, 5, 12))).toBe('2024-01-05');
    expect(parseDateString('2024-01-05')).toBe(Date.UTC(2024, 0, 5));
    expect(() => parseDateString('2024-13-01')).toThrow();
    expect(() => parseDateString('2024-02-30')).toThrow();
    expect(() => parseDateString('nope')).toThrow();
  });
  it('nyDay: the NY calendar day as a UTC span (23 and 25 hours on DST days)', () => {
    expect(nyDay(Date.UTC(2026, 6, 2, 3, 59))).toEqual({
      y: 2026, m: 7, d: 1, dow: 3, start: Date.UTC(2026, 6, 1, 4), end: Date.UTC(2026, 6, 2, 4),
    });
    const spring = nyDay(Date.UTC(2026, 2, 8, 12));
    expect([spring.start, spring.end]).toEqual([Date.UTC(2026, 2, 8, 5), Date.UTC(2026, 2, 9, 4)]);
    const fall = nyDay(Date.UTC(2026, 10, 1, 12));
    expect([fall.start, fall.end]).toEqual([Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5)]);
  });
  it('nyDay matches nyToUtc midnights and nyDayTime matches nyToUtc, every hour across DST weeks', () => {
    for (const from of [Date.UTC(2026, 2, 5), Date.UTC(2026, 9, 29), Date.UTC(1975, 1, 20)]) {
      for (let ts = from; ts < from + 7 * 86_400_000; ts += 3_600_000 + 7 * 60_000) {
        const day = nyDay(ts);
        const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
        expect([day.start, day.end]).toEqual([
          nyToUtc(day.y, day.m, day.d, 0, 0),
          nyToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0),
        ]);
        expect(ts >= day.start && ts < day.end).toBe(true);
        for (const [hh, mm] of [[2, 30], [4, 0], [9, 30], [16, 0], [20, 0]] as const) {
          expect(nyDayTime(day, hh, mm)).toBe(nyToUtc(day.y, day.m, day.d, hh, mm));
        }
      }
    }
  });
  it('memoByNyDay builds once per NY day, sorted or not', () => {
    const built: number[] = [];
    const f = memoByNyDay((day) => { built.push(day.d); return day.d; });
    const ts = [Date.UTC(2026, 6, 1, 4), Date.UTC(2026, 6, 1, 20), Date.UTC(2026, 6, 2, 3, 59), Date.UTC(2026, 6, 2, 4)];
    expect([...ts, ...ts.slice().reverse()].map(f)).toEqual([1, 1, 1, 2, 2, 1, 1, 1]);
    expect(built).toEqual([1, 2]);
  });
});

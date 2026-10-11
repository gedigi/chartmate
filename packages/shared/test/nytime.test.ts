import { describe, it, expect } from 'vitest';
import { nyParts, nyToUtc, nyDateUtcMidnight, utcDateString, parseDateString } from '../src/nytime.js';

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
  it('nyParts round-trips', () => {
    const p = nyParts(Date.UTC(2026, 6, 1, 13, 30));
    expect(p).toMatchObject({ y: 2026, m: 7, d: 1, hh: 9, mm: 30, dow: 3 });
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
});

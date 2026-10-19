import { describe, it, expect } from 'vitest';
import {
  CLOSED_FRESH_CAP_MS, CRYPTO_FRESH_MS, POLL_SLACK_MS, POST_CLOSE_GRACE_MS, STOCK_FRESH_MS, TtlCache, freshUntil,
} from '../../src/market/freshness.js';

const MIN = 60_000;
const HOUR = 3_600_000;

describe('freshUntil', () => {
  it('matches the client poll intervals (crypto 5 s, stocks 15 s), less a small slack for timer jitter', () => {
    expect(CRYPTO_FRESH_MS).toBe(5_000);
    expect(STOCK_FRESH_MS).toBe(15_000);
    expect(POLL_SLACK_MS).toBeGreaterThan(0);
    expect(POLL_SLACK_MS).toBeLessThanOrEqual(1_000);
  });

  it('crypto: always the 5 s window, weekends and nights included', () => {
    const sat = Date.UTC(2026, 9, 31, 7); // Sat 03:00 EDT
    expect(freshUntil('crypto', sat)).toBe(sat + CRYPTO_FRESH_MS - POLL_SLACK_MS);
  });

  it('stocks in any session (pre 04:00 to post 20:00 New York, weekdays): 15 s', () => {
    for (const at of [
      Date.UTC(2026, 10, 4, 9), // Wed 04:00 EST (pre-market opens)
      Date.UTC(2026, 10, 4, 14, 30), // 09:30 regular
      Date.UTC(2026, 10, 4, 21), // 16:00 post
      Date.UTC(2026, 10, 5, 0, 59), // 19:59 post
    ]) expect(freshUntil('stock', at), new Date(at).toISOString()).toBe(at + STOCK_FRESH_MS - POLL_SLACK_MS);
  });

  it('stocks keep the 15 s window for a short grace after the post-market close (late final bars)', () => {
    expect(POST_CLOSE_GRACE_MS).toBe(15 * MIN);
    const at = Date.UTC(2026, 10, 5, 1, 10); // Wed 20:10 EST
    expect(freshUntil('stock', at)).toBe(at + STOCK_FRESH_MS - POLL_SLACK_MS);
  });

  it('stocks overnight: until the next 04:00 New York session start, capped at 6 hours', () => {
    expect(CLOSED_FRESH_CAP_MS).toBe(6 * HOUR);
    const fourAm = Date.UTC(2026, 10, 5, 9); // Thu 04:00 EST
    const at = Date.UTC(2026, 10, 5, 7); // Thu 02:00 EST
    expect(freshUntil('stock', at)).toBe(fourAm);
    expect(freshUntil('stock', fourAm - 1)).toBe(fourAm);
    const late = Date.UTC(2026, 10, 5, 1, 30); // Wed 20:30 EST: 7.5 h before the start
    expect(freshUntil('stock', late)).toBe(late + CLOSED_FRESH_CAP_MS);
  });

  it('stocks on a weekend: until Monday 04:00 New York (capped), across DST', () => {
    const sun = Date.UTC(2026, 10, 1, 23); // Sun 18:00 EST (the day DST ended)
    expect(freshUntil('stock', sun)).toBe(sun + CLOSED_FRESH_CAP_MS);
    const sunLate = Date.UTC(2026, 10, 2, 6); // Mon 01:00 EST
    expect(freshUntil('stock', sunLate)).toBe(Date.UTC(2026, 10, 2, 9)); // Mon 04:00 EST
    const marchSun = Date.UTC(2026, 2, 9, 5); // Mon 2026-03-09 01:00 EDT (DST began Sunday)
    expect(freshUntil('stock', marchSun)).toBe(Date.UTC(2026, 2, 9, 8)); // 04:00 EDT
  });
});

describe('TtlCache', () => {
  it('serves an entry until its expiry, then forgets it', () => {
    const c = new TtlCache<string, number>(10);
    c.set('a', 1, 100, 0);
    expect(c.get('a', 99)).toBe(1);
    expect(c.get('a', 100)).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('is bounded: expired entries go first, then the oldest', () => {
    const c = new TtlCache<string, number>(3);
    c.set('a', 1, 1000, 0);
    c.set('b', 2, 10, 0);
    c.set('c', 3, 1000, 0);
    c.set('d', 4, 1000, 50); // 'b' has expired: it is dropped, 'a' stays
    expect(c.size).toBe(3);
    expect(c.get('a', 50)).toBe(1);
    c.set('e', 5, 1000, 50); // nothing expired: the oldest ('c', after 'a' was read) goes
    expect(c.size).toBe(3);
    expect(c.get('c', 50)).toBeUndefined();
    expect(c.get('a', 50)).toBe(1);
    expect(c.get('e', 50)).toBe(5);
  });

  it('clear empties it', () => {
    const c = new TtlCache<string, number>(3);
    c.set('a', 1, 1000, 0);
    c.clear();
    expect(c.get('a', 0)).toBeUndefined();
  });
});

import { nyDay, nyDayTime, tagSessionFixedHours } from '@chartmate/shared';

/**
 * How long data fetched from a provider is reused before the provider is asked again (in memory, per process).
 * The windows match the client's poll intervals (`pollIntervalMs` in apps/web/src/chart/periods.ts: crypto 5 s,
 * stocks and baskets 15 s), so a single open chart still gets new bars on every poll, while every other request for
 * the same data within the window (a second chart, a basket, the watchlist, a range request) is served from memory.
 */
export const CRYPTO_FRESH_MS = 5_000;
export const STOCK_FRESH_MS = 15_000;
/**
 * Taken off the in-session windows: browser interval timers drift by a few milliseconds either way, and a poll that
 * arrives just before a full window has passed must still reach the provider (or that chart would wait one more
 * poll interval for its new bar).
 */
export const POLL_SLACK_MS = 1_000;
/** The in-session window still applies this long after the 20:00 New York close, so late final bars are picked up. */
export const POST_CLOSE_GRACE_MS = 15 * 60_000;
/** Outside trading hours a stock is fresh until the next 04:00 New York session start, but never longer than this. */
export const CLOSED_FRESH_CAP_MS = 6 * 3_600_000;

const SESSION_START_HOUR = 4;

/** Whether `ts` is in a stock trading session (04:00–20:00 New York on weekdays) or the grace after its close. */
function inStockSession(ts: number): boolean {
  return tagSessionFixedHours(ts) !== null || tagSessionFixedHours(ts - POST_CLOSE_GRACE_MS) !== null;
}

/** The first weekday 04:00 New York strictly after `ts`. Holidays are not modeled (they count as sessions). */
function nextStockSessionStart(ts: number): number {
  let day = nyDay(ts);
  for (let i = 0; i < 8; i++) {
    if (day.dow !== 0 && day.dow !== 6) {
      const start = nyDayTime(day, SESSION_START_HOUR, 0);
      if (start > ts) return start;
    }
    day = nyDay(day.end);
  }
  return ts + CLOSED_FRESH_CAP_MS; // unreachable: a week always holds a weekday
}

/**
 * Until when data fetched at `fetchedAt` is fresh: crypto for 5 s; a stock for 15 s during any session (pre-market
 * through post-market, holidays included since there is no holiday calendar) and its post-close grace, otherwise
 * until the next session start, capped at 6 hours so a missed rule never freezes data for days. The in-session
 * windows are shortened by `POLL_SLACK_MS`.
 */
export function freshUntil(assetClass: 'stock' | 'crypto', fetchedAt: number): number {
  if (assetClass === 'crypto') return fetchedAt + CRYPTO_FRESH_MS - POLL_SLACK_MS;
  if (inStockSession(fetchedAt)) return fetchedAt + STOCK_FRESH_MS - POLL_SLACK_MS;
  return Math.min(nextStockSessionStart(fetchedAt), fetchedAt + CLOSED_FRESH_CAP_MS);
}

/**
 * A small in-memory cache whose entries expire at a given time. Bounded: when full, expired entries are dropped
 * first, then the least recently used.
 */
export class TtlCache<K, V> {
  private readonly m = new Map<K, { value: V; until: number }>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.m.size;
  }

  get(key: K, now: number): V | undefined {
    const e = this.m.get(key);
    if (e === undefined) return undefined;
    this.m.delete(key);
    if (now >= e.until) return undefined;
    this.m.set(key, e); // re-insert: Map order stays least recently used first
    return e.value;
  }

  set(key: K, value: V, until: number, now: number): void {
    const m = this.m;
    m.delete(key);
    if (m.size >= this.max) for (const [k, e] of m) if (e.until <= now) m.delete(k);
    for (const k of m.keys()) {
      if (m.size < this.max) break;
      m.delete(k);
    }
    m.set(key, { value, until });
  }

  clear(): void {
    this.m.clear();
  }
}

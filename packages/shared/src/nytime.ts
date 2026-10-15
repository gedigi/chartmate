export const NY_TZ = 'America/New_York';

export interface NyParts { y: number; m: number /*1-12*/; d: number; hh: number; mm: number; dow: number /*0=Sun*/ }

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(ts: number): NyParts {
  const o: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    y: Number(o.year), m: Number(o.month), d: Number(o.day),
    hh: Number(o.hour) % 24, mm: Number(o.minute), dow: DOW[o.weekday ?? ''] ?? 0,
  };
}

function wallclock(t: number): number {
  const p = nyParts(t);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
}

const DAY_MS = 86_400_000;

function checkInt(name: string, v: number, lo: number, hi: number): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`nyToUtc: ${name} out of range: ${v}`);
}

/**
 * NY wall-clock time to UTC epoch ms (DST-aware).
 *
 * - Month is 1-12, day 1..days-in-month, hour 0-23, minute 0-59 (integers); anything else
 *   throws a `RangeError`.
 * - Non-existent local times (the spring-forward gap, e.g. 02:30 on 2026-03-08) are
 *   interpreted with the pre-transition (EST) offset, i.e. shifted forward by the gap:
 *   02:30 resolves to 03:30 EDT (07:30Z).
 * - Ambiguous local times (the fall-back overlap, e.g. 01:30 on 2026-11-01) resolve to the
 *   earlier instant (EDT): 01:30 EDT = 05:30Z.
 * This matches the `"compatible"` disambiguation of Temporal / JS `Date`.
 */
export function nyToUtc(y: number, m: number, d: number, hh: number, mm: number): number {
  checkInt('year', y, 100, 9999);
  checkInt('month', m, 1, 12);
  checkInt('day', d, 1, new Date(Date.UTC(y, m, 0)).getUTCDate());
  checkInt('hour', hh, 0, 23);
  checkInt('minute', mm, 0, 59);
  const local = Date.UTC(y, m - 1, d, hh, mm);
  const offBefore = (local - DAY_MS) - wallclock(local - DAY_MS);
  const offAfter = (local + DAY_MS) - wallclock(local + DAY_MS);
  const valid = [local + offBefore, local + offAfter].filter((t) => wallclock(t) === local);
  if (valid.length > 0) return Math.min(...valid);
  return local + offBefore; // spring gap
}

/** A NY calendar day: its date, weekday and [start, end) span in UTC epoch ms (23, 24 or 25 hours long). */
export interface NyDay { y: number; m: number /*1-12*/; d: number; dow: number /*0=Sun*/; start: number; end: number }

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

function isNyMidnight(t: number, y: number, m: number, d: number): boolean {
  const q = nyParts(t);
  return q.y === y && q.m === m && q.d === d && q.hh === 0 && q.mm === 0;
}

/** The NY calendar day containing `ts`. */
export function nyDay(ts: number): NyDay {
  const p = nyParts(ts);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const [ny, nm, nd] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  // Fast path (3 lookups instead of ~9): assume the offset at `ts` held since midnight and for 24 hours, and
  // check both midnights. Only a day with an offset change (DST) falls back to resolving each midnight.
  const tsMin = Math.floor(ts / MIN_MS) * MIN_MS;
  const start = Date.UTC(p.y, p.m - 1, p.d) - (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - tsMin);
  const fast = isNyMidnight(start, p.y, p.m, p.d) && isNyMidnight(start + 24 * HOUR_MS, ny, nm, nd);
  return {
    y: p.y, m: p.m, d: p.d, dow: p.dow,
    start: fast ? start : nyToUtc(p.y, p.m, p.d, 0, 0),
    end: fast ? start + 24 * HOUR_MS : nyToUtc(ny, nm, nd, 0, 0),
  };
}

/** `nyToUtc` for a time of `day`: a 24-hour day has one UTC offset throughout, so no lookup is needed. */
export function nyDayTime(day: NyDay, hh: number, mm: number): number {
  return day.end - day.start === 24 * HOUR_MS
    ? day.start + hh * HOUR_MS + mm * MIN_MS
    : nyToUtc(day.y, day.m, day.d, hh, mm);
}

/**
 * Memoizes `build(day)` per NY day, for scans over many timestamps: time-zone lookups (Intl) are slow, and a scan
 * of sorted bars then makes a few per day instead of one or more per bar. A UTC hour never straddles two NY days
 * (the offset is a whole number of hours), so unsorted input is served from a per-hour index.
 */
export function memoByNyDay<T>(build: (day: NyDay) => T): (ts: number) => T {
  let cur: { day: NyDay; value: T } | undefined;
  const byHour = new Map<number, { day: NyDay; value: T }>();
  return (ts) => {
    if (cur && ts >= cur.day.start && ts < cur.day.end) return cur.value;
    const hour = Math.floor(ts / HOUR_MS);
    let hit = byHour.get(hour);
    if (!hit) {
      const day = nyDay(ts);
      hit = { day, value: build(day) };
      // (Before 1883 NY ran on local mean time, not a whole-hour offset: no hour index there.)
      if (day.start % HOUR_MS === 0 && day.end % HOUR_MS === 0) {
        for (let h = day.start / HOUR_MS; h * HOUR_MS < day.end; h++) byHour.set(h, hit);
      }
    }
    cur = hit;
    return hit.value;
  };
}

export function nyDateUtcMidnight(ts: number): number {
  const p = nyParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d);
}

export function utcDateString(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function parseDateString(s: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid date: ${s}`);
  const ts = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ts) || utcDateString(ts) !== s) throw new Error(`invalid date: ${s}`);
  return ts;
}

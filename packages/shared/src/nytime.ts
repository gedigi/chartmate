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

/** NY wall-clock time to UTC epoch ms (DST-aware). */
export function nyToUtc(y: number, m: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset1 = guess - wallclock(guess);
  const candidate = guess + offset1;
  const offset2 = candidate - wallclock(candidate);
  return guess + offset2;
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

import { isIntraday, nyParts, nyToUtc, tfMs, type AssetClass, type SessionMode, type Timeframe } from '@chartmate/shared';

/**
 * Time texts drawn on the chart: time-axis tick labels with context ("Sep 21", "22", "13:30"), the crosshair date chip
 * ("Wed Sep 30 '26 · 12:30") and the bar-close countdown in the last price capsule. Pure; the timezone is the chart's.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Parts { year: number; month: number; day: number; weekday: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Calendar parts of `ts` in `timeZone` (month 0-based, weekday 0 = Sunday). */
export function zonedParts(ts: number, timeZone: string): Parts {
  const p: Record<string, string> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(ts)) p[type] = value;
  return {
    year: Number(p['year']), month: Number(p['month']) - 1, day: Number(p['day']),
    weekday: WEEKDAYS.indexOf(p['weekday'] ?? ''), hour: Number(p['hour']) % 24, minute: Number(p['minute']),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const hhmm = (p: Parts) => `${pad2(p.hour)}:${pad2(p.minute)}`;

/** Closest two time-axis ticks may be (px): room for the widest label ("Sep 21", "13:30") and some air. */
export const MIN_TICK_GAP_PX = 60;
/** Estimated width of one character of a time-axis label (11 px medium system sans-serif; a little generous). */
export const AXIS_CHAR_PX = 7;
/** Closest a time-axis label may come to the plot's left / right edge (px). */
export const AXIS_EDGE_PX = 12;

/** Whether a tick label `text` centered at `x` stays AXIS_EDGE_PX inside a plot `width` px wide (else it is cut). */
export function tickLabelFits(x: number, text: string, width: number): boolean {
  const half = (text.length * AXIS_CHAR_PX) / 2;
  return x - half >= AXIS_EDGE_PX && x + half <= width - AXIS_EDGE_PX;
}

/** A bar's calendar in the chart timezone: date (month 0-based), minute of the day, days since 1970-01-01. */
interface Cal { y: number; m: number; d: number; minute: number; days: number }
/**
 * A calendar unit ticks fall on (a larger rank is a larger unit):
 * - 'step': a clock step within the day (5 minutes … 12 hours), on multiples of the step from midnight;
 * - 'nested': day, half month (the 1st and the 15th), month, quarter, half year, year: each start is also a start of
 *   every smaller one of these;
 * - 'week' (Monday to Sunday) and 'years' (2 / 5 / 10 years), which do not nest with the others.
 */
interface TickUnit { rank: number; kind: 'step' | 'nested' | 'week' | 'years'; key: (c: Cal) => number }

const step = (rank: number, minutes: number): TickUnit => ({ rank, kind: 'step', key: (c) => c.days * 1440 + Math.floor(c.minute / minutes) });
const RANK = { day: 9, week: 10, month: 12, year: 15 } as const;
const UNITS: readonly TickUnit[] = [
  step(1, 5), step(2, 15), step(3, 30), step(4, 60), step(5, 120), step(6, 180), step(7, 360), step(8, 720),
  { rank: RANK.day, kind: 'nested', key: (c) => c.days },
  { rank: RANK.week, kind: 'week', key: (c) => Math.floor((c.days + 3) / 7) }, // Monday weeks (1970-01-01 was a Thursday)
  { rank: 11, kind: 'nested', key: (c) => c.y * 24 + c.m * 2 + (c.d >= 15 ? 1 : 0) },
  { rank: RANK.month, kind: 'nested', key: (c) => c.y * 12 + c.m },
  { rank: 13, kind: 'nested', key: (c) => c.y * 4 + Math.floor(c.m / 3) },
  { rank: 14, kind: 'nested', key: (c) => c.y * 2 + Math.floor(c.m / 6) },
  { rank: RANK.year, kind: 'nested', key: (c) => c.y },
  { rank: 16, kind: 'years', key: (c) => Math.floor(c.y / 2) },
  { rank: 17, kind: 'years', key: (c) => Math.floor(c.y / 5) },
  { rank: 18, kind: 'years', key: (c) => Math.floor(c.y / 10) },
];
/** The finest unit worth trying for bars of each timeframe (a finer one would tick every bar). */
const FIRST_RANK: Record<Timeframe, number> = {
  '1m': 1, '5m': 1, '15m': 2, '30m': 3, '1h': 4, '2h': 5, '4h': 7, '1D': RANK.day, '1W': RANK.week, '1M': RANK.month,
};

/** Calendar reader for `timeZone`: its UTC offset is looked up once per UTC hour (zone offsets are whole hours). */
function calendarReader(timeZone: string): (ts: number) => Cal {
  const offsets = new Map<number, number>();
  return (ts) => {
    const hour = Math.floor(ts / HOUR_MS);
    let off = offsets.get(hour);
    if (off === undefined) {
      if (timeZone === 'UTC') off = 0;
      else {
        const p = zonedParts(hour * HOUR_MS, timeZone);
        off = Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - hour * HOUR_MS;
      }
      offsets.set(hour, off);
    }
    const local = ts + off;
    const t = new Date(local);
    return {
      y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(),
      minute: t.getUTCHours() * 60 + t.getUTCMinutes(), days: Math.floor(local / DAY_MS),
    };
  };
}

/**
 * Ticks of unit `u` (indexes into the bars), or null when two of them would come closer than `minGap` px. Only one
 * thing may give way: a clock-step tick next to a day start (a session opens at 09:30 or 04:00, off the step's grid).
 */
function unitTicks(u: TickUnit, ranks: readonly number[], changed: (u: TickUnit, i: number) => boolean, barSpace: number, minGap: number): number[] | null {
  const kept: number[] = [];
  for (let i = 1; i < ranks.length; i++) {
    const tick = u.kind === 'step' || u.kind === 'nested' ? ranks[i]! >= u.rank : changed(u, i);
    if (!tick) continue;
    const last = kept.at(-1);
    if (last === undefined || (i - last) * barSpace >= minGap) {
      kept.push(i);
      continue;
    }
    if (u.kind !== 'step') return null;
    const dayHere = ranks[i]! >= RANK.day;
    const dayThere = ranks[last]! >= RANK.day;
    if (!dayHere && dayThere) continue; // a step just after a day start
    if (dayHere && !dayThere) { // a step just before a day start
      const before = kept.at(-2);
      if (before !== undefined && (i - before) * barSpace < minGap) return null;
      kept[kept.length - 1] = i;
      continue;
    }
    return null;
  }
  return kept;
}

/**
 * Time-axis ticks on calendar boundaries, for bars at `times` drawn `barSpace` px apart. `times` are ascending: the
 * bars in view, preceded by the bar before them when there is one (a bar is a boundary against the bar before it,
 * so the first is never a tick). The finest unit whose ticks all stay at least `minGap` px apart is used: 5 / 15 / 30
 * minutes or 1 / 2 / 3 / 6 / 12 hours (on clock multiples of the step; a step tick right next to a session's day start
 * gives way to it), days, weeks (on each week's first bar), half months (the 1st and the 15th, or the next bar),
 * months, quarters, half years, years, 2 / 5 / 10 years. No tick of the chosen unit is ever skipped, so ticks are
 * evenly spaced in calendar time. A label names the largest unit starting there: "2026", "Sep" ("Sep 21" on intraday
 * bars), "21", "13:30"; on the week grid a week starting a new month reads "Oct 5". Returns indexes into `times`.
 */
export function calendarTicks(
  times: readonly number[], barSpace: number, tf: Timeframe, timeZone: string, minGap = MIN_TICK_GAP_PX,
): Array<{ index: number; label: string }> {
  if (times.length < 2 || !(barSpace > 0)) return [];
  const cals = times.map(calendarReader(timeZone));
  const units = UNITS.filter((u) => u.rank >= FIRST_RANK[tf]);
  const changed = (u: TickUnit, i: number) => i > 0 && u.key(cals[i]!) !== u.key(cals[i - 1]!);
  // Rank of the largest clock step or nested unit starting at each bar (0: none).
  const ranks = cals.map((_, i) => {
    let r = 0;
    for (const u of units) if ((u.kind === 'step' || u.kind === 'nested') && changed(u, i)) r = Math.max(r, u.rank);
    return r;
  });
  let chosen = units.at(-1)!;
  let ticks: number[] | null = null;
  for (const u of units) {
    ticks = unitTicks(u, ranks, changed, barSpace, minGap);
    if (ticks) {
      chosen = u;
      break;
    }
  }
  // Even the largest unit crowds (a sliver of decades): every 10-year start, however close.
  ticks ??= ranks.flatMap((_, i) => (changed(chosen, i) ? [i] : []));
  const intraday = isIntraday(tf);
  return ticks.map((i, k) => {
    const c = cals[i]!;
    if (chosen.kind === 'years') return { index: i, label: String(c.y) };
    if (chosen.kind === 'week') {
      const prev = cals[k > 0 ? ticks![k - 1]! : 0]!;
      const label = c.y !== prev.y ? String(c.y) : c.m !== prev.m ? `${MONTHS[c.m]} ${c.d}` : String(c.d);
      return { index: i, label };
    }
    const r = ranks[i]!;
    const label = r >= RANK.year ? String(c.y)
      : r >= RANK.month ? (intraday ? `${MONTHS[c.m]} ${c.d}` : MONTHS[c.m]!)
        : r >= RANK.day ? String(c.d)
          : `${pad2(Math.floor(c.minute / 60))}:${pad2(c.minute % 60)}`;
    return { index: i, label };
  });
}

/** The crosshair date chip: "Wed Sep 30 '26 · 12:30" intraday, "Wed Sep 30 '26" daily / weekly, "Sep 2026" monthly. */
export function crosshairDate(ts: number, tf: Timeframe, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  if (tf === '1M') return `${MONTHS[p.month]} ${p.year}`;
  const date = `${WEEKDAYS[p.weekday]} ${MONTHS[p.month]} ${p.day} '${String(p.year).slice(2)}`;
  return isIntraday(tf) ? `${date} · ${hhmm(p)}` : date;
}

/**
 * Whether the last price capsule shows a bar-close countdown: intraday bars (they close on the clock), and daily
 * crypto bars (UTC days). Stock daily+ bars close with the session (holidays, half days), so none there.
 */
export function hasCountdown(tf: Timeframe, assetClass: AssetClass): boolean {
  return isIntraday(tf) || (tf === '1D' && assetClass === 'crypto');
}

/**
 * When the bar starting at `barTs` closes: its start + the timeframe, cut at the session close for stock-like
 * charts (`session`: 16:00 New York for regular hours, 20:00 with extended hours; DST-aware) — a 1h bar starting at
 * 15:30 closes at 16:00, a 4h bar starting at 13:30 too. Without `session` (crypto) the clock alone decides.
 */
export function barCloseTime(barTs: number, tf: Timeframe, session?: SessionMode): number {
  const end = barTs + tfMs(tf);
  if (!session || !isIntraday(tf)) return end;
  const p = nyParts(barTs);
  return Math.min(end, nyToUtc(p.y, p.m, p.d, session === 'eth' ? 20 : 16, 0));
}

/**
 * Time left until the bar starting at `barTs` closes (see barCloseTime): "4:59" (m:ss), "1:04:59" (h:mm:ss);
 * "Closed" once its end has passed (e.g. the last session bar of a stock outside market hours).
 */
export function countdownText(barTs: number, tf: Timeframe, now: number, session?: SessionMode): string {
  const left = Math.ceil((barCloseTime(barTs, tf, session) - now) / 1000);
  if (left <= 0) return 'Closed';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

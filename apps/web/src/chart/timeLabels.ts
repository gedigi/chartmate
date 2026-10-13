import { isIntraday, tfMs, type AssetClass, type Timeframe } from '@chartmate/shared';

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
const hhmm = (p: Parts) => `${pad2(p.hour)}:${pad2(p.minute)}`;

/**
 * Labels of time-axis ticks (ascending timestamps), each read against the previous tick: the first tick and a new
 * period carry the larger unit. Intraday: a new month "Sep 21", a new day "22", else "13:30". Daily / weekly: a new
 * year "2026", a new month "Sep", else the day "22". Monthly: a new year "2026", else "Feb".
 */
export function axisTickLabels(timestamps: readonly number[], tf: Timeframe, timeZone: string): string[] {
  let prev: Parts | null = null;
  return timestamps.map((ts) => {
    const p = zonedParts(ts, timeZone);
    const newYear = !prev || p.year !== prev.year;
    const newMonth = newYear || p.month !== prev!.month;
    const newDay = newMonth || p.day !== prev!.day;
    prev = p;
    if (isIntraday(tf)) {
      if (newMonth) return `${MONTHS[p.month]} ${p.day}`;
      return newDay ? String(p.day) : hhmm(p);
    }
    if (tf === '1M') return newYear ? String(p.year) : MONTHS[p.month]!;
    if (newYear) return String(p.year);
    return newMonth ? MONTHS[p.month]! : String(p.day);
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
 * Time left until the bar starting at `barTs` closes: "4:59" (m:ss), "1:04:59" (h:mm:ss); "Closed" once its end has
 * passed (e.g. the last session bar of a stock outside market hours).
 */
export function countdownText(barTs: number, tf: Timeframe, now: number): string {
  const left = Math.ceil((barTs + tfMs(tf) - now) / 1000);
  if (left <= 0) return 'Closed';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

const DAY = 86_400_000;

/** A split as `applied_splits` records it: its NY date (UTC midnight of the date) and ratio (null = unknown). */
export interface AppliedSplit {
  day: number;
  factor: number | null;
}

const isWeekday = (day: number) => {
  const dow = new Date(day).getUTCDay();
  return dow !== 0 && dow !== 6;
};

/**
 * NY trading days from one date to the other (UTC midnights, either order): the weekdays after the earlier date up
 * to and including the later one. Friday to Monday and Sunday to Monday are 1. Exchange holidays are not skipped.
 */
export function tradingDayGap(a: number, b: number): number {
  const [from, to] = a <= b ? [a, b] : [b, a];
  let gap = 0;
  for (let day = from + DAY; day <= to; day += DAY) if (isWeekday(day)) gap++;
  return gap;
}

const sameFactor = (a: number | null, b: number | null) =>
  a === null || b === null || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/**
 * True when two split reports are the same event: the same ratio (or an unknown one on either side) within one NY
 * trading day. A provider may restamp an event across a NY date boundary (00:00 UTC is the evening before in New
 * York, 04:00 or 05:00 UTC that day), and two real splits of one stock never come a trading day apart.
 */
export function isSameSplit(a: AppliedSplit, b: AppliedSplit): boolean {
  return sameFactor(a.factor, b.factor) && tradingDayGap(a.day, b.day) <= 1;
}

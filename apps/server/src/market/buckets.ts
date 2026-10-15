import { bucketStart, tfMs, type Calendar, type Timeframe } from '@chartmate/shared';

/** Exclusive end of the `tf` bucket that contains `ts` (calendar months for 1M). */
export function bucketEnd(ts: number, tf: Timeframe, cal: Calendar): number {
  const start = bucketStart(ts, tf, cal);
  if (tf === '1M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + tfMs(tf);
}

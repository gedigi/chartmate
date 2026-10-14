import type { Timeframe } from './types.js';

export const TIMEFRAMES: readonly Timeframe[] = ['1m','5m','15m','30m','1h','2h','4h','1D','1W','1M'];

export function isTimeframe(x: string): x is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(x);
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MS: Record<Timeframe, number> = {
  '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '30m': 30 * MIN,
  '1h': HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR,
  '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY,
};

/** Nominal duration in ms (1M is nominally 30 days). */
export function tfMs(tf: Timeframe): number {
  return MS[tf];
}

export function isIntraday(tf: Timeframe): boolean {
  return MS[tf] < DAY;
}

export type NativeTimeframe = '1m'|'5m'|'15m'|'30m'|'1h'|'1D';

export function baseTimeframe(tf: Timeframe): NativeTimeframe {
  switch (tf) {
    case '2h': case '4h': return '1h';
    case '1W': case '1M': return '1D';
    default: return tf;
  }
}

import { TIMEFRAMES, tfMs, type AssetClass, type Timeframe } from '@altv/shared';

export type PeriodType = 'minute' | 'hour' | 'day' | 'week' | 'month';
export interface ChartPeriod { type: PeriodType; span: number }

const DAY = 86_400_000;
const YEAR = 365 * DAY;

const PERIODS: Record<Timeframe, ChartPeriod> = {
  '1m': { type: 'minute', span: 1 },
  '5m': { type: 'minute', span: 5 },
  '15m': { type: 'minute', span: 15 },
  '30m': { type: 'minute', span: 30 },
  '1h': { type: 'hour', span: 1 },
  '2h': { type: 'hour', span: 2 },
  '4h': { type: 'hour', span: 4 },
  '1D': { type: 'day', span: 1 },
  '1W': { type: 'week', span: 1 },
  '1M': { type: 'month', span: 1 },
};

const INITIAL_WINDOW: Record<Timeframe, number> = {
  '1m': 2 * DAY, '5m': 7 * DAY, '15m': 14 * DAY, '30m': 28 * DAY,
  '1h': 60 * DAY, '2h': 120 * DAY, '4h': 240 * DAY,
  '1D': 3 * YEAR, '1W': 15 * YEAR, '1M': 40 * YEAR,
};

/** Server-side cap is 4000 × tf per request; retries stay safely below it. */
const MAX_RETRY_BARS = 3900;

export function toPeriod(tf: Timeframe): ChartPeriod {
  return { ...PERIODS[tf] };
}

/** Inverse of toPeriod; throws for periods the app does not use. */
export function fromPeriod(p: { type: string; span: number }): Timeframe {
  const tf = TIMEFRAMES.find((t) => PERIODS[t].type === p.type && PERIODS[t].span === p.span);
  if (!tf) throw new Error(`unsupported period: ${p.span} ${p.type}`);
  return tf;
}

/** Span of the first request (and of each older-data page). */
export function initialWindowMs(tf: Timeframe): number {
  return INITIAL_WINDOW[tf];
}

/** Window for the single retry after an empty older-data page: 4× the initial window, capped below the server limit. */
export function forwardRetryWindowMs(tf: Timeframe): number {
  return Math.min(4 * initialWindowMs(tf), MAX_RETRY_BARS * tfMs(tf));
}

/** Real-time polling interval. Callers pass 'crypto' for baskets that contain crypto. */
export function pollIntervalMs(assetClass: AssetClass): number {
  return assetClass === 'crypto' ? 5000 : 15000;
}

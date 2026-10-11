import type { Bar, BasketVersion, Marker, SymbolId } from './types.js';
import { parseSymbolId } from './types.js';
import { parseDateString, utcDateString } from './nytime.js';

const DAY_MS = 86_400_000;

export class BasketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BasketValidationError';
  }
}

export function validateVersions(versions: BasketVersion[]): void {
  if (versions.length === 0) throw new BasketValidationError('Basket needs at least one version');
  let prevTs = -Infinity;
  versions.forEach((v, k) => {
    const label = `Version ${k + 1}`;
    let ts: number;
    try {
      ts = parseDateString(v.effectiveFrom);
    } catch {
      throw new BasketValidationError(`${label}: invalid effectiveFrom date ${v.effectiveFrom}`);
    }
    if (ts <= prevTs) throw new BasketValidationError(`${label}: effectiveFrom must be strictly after the previous version`);
    prevTs = ts;
    const entries = Object.entries(v.weights);
    if (entries.length === 0) throw new BasketValidationError(`${label}: no weights`);
    let sum = 0;
    for (const [id, w] of entries) {
      let cls: string;
      try {
        cls = parseSymbolId(id).assetClass;
      } catch {
        throw new BasketValidationError(`${label}: invalid constituent ${id}`);
      }
      if (cls !== 'stock' && cls !== 'crypto') throw new BasketValidationError(`${label}: ${id} cannot be a constituent (no nested baskets)`);
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) throw new BasketValidationError(`${label}: weight for ${id} must be a positive number`);
      sum += w;
    }
    if (Math.abs(sum - 1) > 1e-6) throw new BasketValidationError(`${label}: weights must sum to 1 (got ${sum})`);
  });
}

export function normalizeWeights(w: Record<string, number>): Record<string, number> {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) throw new Error('Weights must sum to a positive number');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) out[k] = v / sum;
  return out;
}

export type DailySeries = Record<SymbolId, Bar[]>;
export interface VersionUnits { effectiveTs: number; units: Record<SymbolId, number>; levelAtStart: number }
export interface UnitsResult { versions: VersionUnits[]; startTs: number; notices: string[] }

/** Index of the first bar with ts >= t (bars ascending). */
function lowerBound(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Close of the last bar with bar.ts < ts, or undefined. */
function priorClose(bars: Bar[] | undefined, ts: number): number | undefined {
  if (!bars) return undefined;
  const i = lowerBound(bars, ts);
  return i === 0 ? undefined : bars[i - 1]!.close;
}

export function computeVersionUnits(versions: BasketVersion[], daily: DailySeries, baseValue: number): UnitsResult {
  if (!Number.isFinite(baseValue) || !(baseValue > 0)) throw new BasketValidationError('baseValue must be a positive finite number');
  const v0 = versions[0];
  if (!v0) throw new BasketValidationError('Basket needs at least one version');
  const notices: string[] = [];
  const T = parseDateString(v0.effectiveFrom);

  let S = T;
  let limitingId: SymbolId | undefined;
  for (const id of Object.keys(v0.weights)) {
    const bars = daily[id];
    if (!bars || bars.length === 0) throw new BasketValidationError('No data for ' + id);
    const cand = bars[0]!.ts + DAY_MS;
    if (cand > S) {
      S = cand;
      limitingId = id;
    }
  }
  if (S > T && limitingId !== undefined) {
    notices.push(`Basket starts ${utcDateString(S)}: ${limitingId} has no data before that date.`);
  }

  const units0: Record<SymbolId, number> = {};
  for (const [id, w] of Object.entries(v0.weights)) {
    const pc = priorClose(daily[id], S);
    if (pc === undefined || pc === 0) throw new BasketValidationError('No data for ' + id);
    units0[id] = (w * baseValue) / pc;
  }
  const out: VersionUnits[] = [{ effectiveTs: S, units: units0, levelAtStart: baseValue }];

  for (let k = 1; k < versions.length; k++) {
    const v = versions[k]!;
    const Tk = parseDateString(v.effectiveFrom);
    if (Tk <= S) throw new BasketValidationError('Version ' + (k + 1) + ' starts before basket start');
    const prev = out[k - 1]!;
    let L = 0;
    for (const [id, u] of Object.entries(prev.units)) {
      const pc = priorClose(daily[id], Tk);
      if (pc === undefined) throw new BasketValidationError('No data for ' + id + ' before ' + v.effectiveFrom);
      L += u * pc;
    }
    if (!Number.isFinite(L) || !(L > 0)) throw new BasketValidationError('Version ' + (k + 1) + ' has non-positive index level before ' + v.effectiveFrom);
    const units: Record<SymbolId, number> = {};
    for (const [id, w] of Object.entries(v.weights)) {
      const pc = priorClose(daily[id], Tk);
      if (pc === undefined || pc === 0) throw new BasketValidationError('No data for ' + id + ' before ' + v.effectiveFrom);
      units[id] = (w * L) / pc;
    }
    out.push({ effectiveTs: Tk, units, levelAtStart: L });
  }

  return { versions: out, startTs: S, notices };
}

export interface ConstituentSeries { id: SymbolId; bars: Bar[] }

export function buildBasketBars(units: UnitsResult, series: ConstituentSeries[]): Bar[] {
  const { startTs, versions } = units;
  const tsSet = new Set<number>();
  const idx: number[] = [];
  const last: (number | undefined)[] = [];
  const byId = new Map<SymbolId, number>();
  series.forEach((s, j) => {
    byId.set(s.id, j);
    const i = lowerBound(s.bars, startTs);
    idx.push(i);
    last.push(i > 0 ? s.bars[i - 1]!.close : undefined);
    for (let m = i; m < s.bars.length; m++) tsSet.add(s.bars[m]!.ts);
  });
  const timeline = [...tsSet].sort((a, b) => a - b);

  const out: Bar[] = [];
  let vi = 0;
  // Current bar of each series at timeline step (undefined when none at t).
  const cur: (Bar | undefined)[] = new Array(series.length);
  for (const t of timeline) {
    while (vi + 1 < versions.length && versions[vi + 1]!.effectiveTs <= t) vi++;
    for (let j = 0; j < series.length; j++) {
      const bars = series[j]!.bars;
      let b: Bar | undefined;
      let i = idx[j]!;
      while (i < bars.length && bars[i]!.ts <= t) {
        if (bars[i]!.ts === t) b = bars[i];
        i++;
      }
      idx[j] = i;
      cur[j] = b;
    }
    let o = 0, h = 0, l = 0, c = 0;
    let complete = true;
    let real = false;
    const ver = versions[vi]!;
    for (const [id, u] of Object.entries(ver.units)) {
      const j = byId.get(id);
      if (j === undefined) { complete = false; break; }
      const b = cur[j];
      if (b) {
        real = true;
        o += u * b.open; h += u * b.high; l += u * b.low; c += u * b.close;
      } else {
        const lc = last[j];
        if (lc === undefined) { complete = false; break; }
        o += u * lc; h += u * lc; l += u * lc; c += u * lc;
      }
    }
    // Update last closes for every series that had a bar at t.
    for (let j = 0; j < series.length; j++) if (cur[j]) last[j] = cur[j]!.close;
    if (complete && real) out.push({ ts: t, open: o, high: h, low: l, close: c, volume: 0 });
  }
  return out;
}

export function versionMarkers(units: UnitsResult): Marker[] {
  return units.versions.slice(1).map((v, i) => ({ ts: v.effectiveTs, label: `v${i + 2}` }));
}

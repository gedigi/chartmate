import { randomUUID } from 'node:crypto';
import {
  BasketValidationError, baseTimeframe, bucketStart, buildBasketBars, computeVersionUnits, filterSession,
  isIntraday, parseDateString, parseSymbolId, resample, tfMs, utcDateString, validateVersions, versionMarkers,
  type Bar, type Basket, type BasketVersion, type Calendar, type ConstituentSeries, type Marker,
  type SessionMode, type SymbolId, type Timeframe, type UnitsResult,
} from '@altv/shared';
import type { Repos } from '../db/repos.js';
import { AppError, NotFoundError } from '../errors.js';
import type { MarketDataService } from '../market/service.js';

const DAY = 86_400_000;
const UNITS_TTL_MS = 6 * 3_600_000;
const INTRADAY_PAD_MS = 5 * DAY;
/** getLatest's intraday pad for baskets holding a stock: covers a long weekend so forward-fill has a prior close. */
const LATEST_STOCK_PAD_MS = 4 * DAY;
const DAILY_PAD_MS = 10 * DAY;
const UNITS_LOOKBACK_MS = 10 * DAY;
const MAX_NAME = 80;
export const INTRADAY_HL_NOTICE = 'Basket high/low are approximate (sum of constituent extremes).';
export const START_MARKER = 'Start';
export const simulatedNotice = (startTs: number) => `Before ${utcDateString(startTs)}: simulated with the starting holdings.`;
export const noSessionsNotice = (startTs: number) => `Basket starts ${utcDateString(startTs)}; no completed sessions yet.`;

export type BarsResponseCore = { bars: Bar[]; stale: boolean; hasMoreBefore: boolean; notices: string[]; markers: Marker[] };

export interface BasketBarsArgs {
  id: string; tf: Timeframe; session: SessionMode; from: number; to: number;
  /** History fetched before the first base bar to seed forward-fill (default: 5 d intraday, 10 d daily). */
  padMs?: number;
}

interface CachedUnits { key: string; units: UnitsResult; at: number }

const invalid = (message: string) => new AppError(400, 'invalid_basket', message);
const unavailable = () => new AppError(503, 'data_unavailable', 'Market data temporarily unavailable; try again');

function constituents(versions: BasketVersion[]): SymbolId[] {
  return [...new Set(versions.flatMap((v) => Object.keys(v.weights)))];
}

function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length < 1 || n.length > MAX_NAME) throw invalid(`Basket name must be 1–${MAX_NAME} characters`);
  return n;
}

/** Exclusive end of the `tf` bucket containing `ts`. */
function bucketEnd(ts: number, tf: Timeframe, cal: Calendar): number {
  const start = bucketStart(ts, tf, cal);
  if (tf === '1M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + tfMs(tf);
}

export class BasketService {
  private readonly repos: Repos;
  private readonly market: MarketDataService;
  private readonly now: () => number;
  private readonly unitsCache = new Map<string, CachedUnits>();

  constructor(deps: { repos: Repos; market: MarketDataService; now?: () => number }) {
    this.repos = deps.repos;
    this.market = deps.market;
    this.now = deps.now ?? Date.now;
  }

  list(): Promise<Basket[]> {
    return this.repos.baskets.list();
  }

  async get(id: string): Promise<Basket> {
    const b = await this.repos.baskets.get(id);
    if (!b) throw new NotFoundError(`Basket ${id} not found`);
    return b;
  }

  async create(input: { name: string; baseValue?: number; versions: BasketVersion[] }): Promise<Basket> {
    const name = cleanName(input.name);
    const baseValue = input.baseValue ?? 100;
    if (typeof baseValue !== 'number' || !Number.isFinite(baseValue) || !(baseValue > 0)) {
      throw invalid('baseValue must be a positive finite number');
    }
    const dry = await this.validate(input.versions, baseValue);
    const basket = await this.repos.baskets.create({ id: randomUUID(), name, baseValue, versions: input.versions });
    this.seed(basket.id, input.versions, dry);
    return basket;
  }

  async update(id: string, patch: { name?: string; versions?: BasketVersion[] }): Promise<Basket> {
    const current = await this.get(id);
    const clean: { name?: string; versions?: BasketVersion[] } = {};
    if (patch.name !== undefined) clean.name = cleanName(patch.name);
    let dry: { units: UnitsResult; stale: boolean } | undefined;
    if (patch.versions !== undefined) {
      dry = await this.validate(patch.versions, current.baseValue);
      clean.versions = patch.versions;
    }
    const updated = await this.repos.baskets.update(id, clean);
    if (!updated) throw new NotFoundError(`Basket ${id} not found`);
    if (clean.versions && dry) {
      this.unitsCache.delete(id);
      this.seed(id, clean.versions, dry);
    }
    return updated;
  }

  async appendVersion(id: string, v: BasketVersion): Promise<Basket> {
    const current = await this.get(id);
    return this.update(id, { versions: [...current.versions, v] });
  }

  async delete(id: string): Promise<void> {
    this.unitsCache.delete(id);
    if (!(await this.repos.baskets.delete(id))) throw new NotFoundError(`Basket ${id} not found`);
  }

  async getBars(a: BasketBarsArgs): Promise<BarsResponseCore> {
    const basket = await this.get(a.id);
    const { units, stale: unitsStale } = await this.unitsFor(basket);
    const S = units.startTs;
    const markers: Marker[] = [
      ...(S >= a.from && S < a.to ? [{ ts: S, label: START_MARKER }] : []),
      ...versionMarkers(units).filter((m) => m.ts >= a.from && m.ts < a.to),
    ];
    const notices = [...units.notices];
    if (isIntraday(a.tf)) notices.push(INTRADAY_HL_NOTICE);

    const all = constituents(basket.versions);
    const anyCrypto = all.some((id) => parseSymbolId(id).assetClass === 'crypto');
    const calendar: Calendar = anyCrypto ? 'utc' : a.session === 'eth' ? 'nyse-eth' : 'nyse-rth';
    const base = baseTimeframe(a.tf);
    const derived = a.tf !== base;
    const outCal: Calendar = isIntraday(a.tf) ? calendar : 'utc';
    // A derived bucket starting before `to` needs its base bars up to the bucket's end.
    const baseTo = derived ? Math.max(a.to, bucketEnd(a.to - 1, a.tf, outCal)) : a.to;
    // Build base bars from the start of the bucket containing `a.from` so a kept leading bucket is complete.
    // Before the basket start S the bars are simulated with version 0's units (shared engine).
    const baseFrom = derived ? bucketStart(a.from, a.tf, outCal) : a.from;
    const fetchFrom = baseFrom - (a.padMs ?? (isIntraday(base) ? INTRADAY_PAD_MS : DAILY_PAD_MS));

    // Only versions active somewhere in [fetchFrom, baseTo) need their constituents' bars (version 0 is also
    // active for everything before S).
    const vs = units.versions;
    const relevant = vs.filter((v, k) => (k === 0 || v.effectiveTs < baseTo) && (vs[k + 1]?.effectiveTs ?? Infinity) > fetchFrom);
    const ids = [...new Set(relevant.flatMap((v) => Object.keys(v.units)))];

    const fetched = await Promise.all(ids.map(async (id): Promise<ConstituentSeries & { stale: boolean }> => {
      const r = await this.market.getNativeBars(id, base, fetchFrom, baseTo);
      let bars = r.bars;
      if (isIntraday(base)) {
        if (parseSymbolId(id).assetClass === 'stock') bars = filterSession(bars, a.session);
        if (calendar === 'utc') bars = resample(bars, base, 'utc');
      }
      return { id, bars, stale: r.stale };
    }));

    let bars = buildBasketBars(units, fetched, { simulate: true }).filter((b) => b.ts >= baseFrom); // drop padding
    if (derived) bars = resample(bars, a.tf, outCal);
    bars = bars.filter((b) => b.ts >= a.from && b.ts < a.to); // [from, to) contract on output timestamps

    if (bars.some((b) => b.simulated)) notices.push(simulatedNotice(S));
    if (bars.length === 0 && a.to >= this.now()) {
      // Nothing to show up to now: a basket starting today / tomorrow before any constituent session completed.
      const lastTs = Math.max(-Infinity, ...fetched.map((f) => f.bars.at(-1)?.ts ?? -Infinity));
      if (S >= lastTs) notices.push(noSessionsNotice(S));
    }

    // Earliest available history: simulated bars reach back to the latest first bar of version 0's constituents.
    const earliest = await Promise.all(Object.keys(vs[0]!.units).map((id) => this.market.earliest(id, base)));
    const floor = Math.max(...earliest.map((e) => e ?? -Infinity));

    return {
      bars,
      stale: unitsStale || fetched.some((s) => s.stale),
      hasMoreBefore: a.from > floor,
      notices,
      markers,
    };
  }

  async getLatest(id: string, tf: Timeframe, session: SessionMode): Promise<{ bar: Bar | null; stale: boolean }> {
    const basket = await this.get(id);
    const classes = constituents(basket.versions).map((c) => parseSymbolId(c).assetClass);
    const anyCrypto = classes.includes('crypto');
    const cal: Calendar = !isIntraday(tf) || anyCrypto ? 'utc' : session === 'eth' ? 'nyse-eth' : 'nyse-rth';
    const now = this.now();
    const back = tf === '1W' ? 7 * DAY : tf === '1M' ? 31 * DAY : tfMs(tf);
    // Polled often: fetch just enough history to seed forward-fill (stocks: across a long weekend).
    const base = baseTimeframe(tf);
    const padMs = !isIntraday(base) ? undefined : classes.includes('stock') ? LATEST_STOCK_PAD_MS : 2 * tfMs(base);
    const r = await this.getBars({
      id, tf, session, from: bucketStart(now, tf, cal) - back, to: now + tfMs(tf), ...(padMs !== undefined ? { padMs } : {}),
    });
    return { bar: r.bars.at(-1) ?? null, stale: r.stale };
  }

  /** Validation order: versions shape → constituents exist → engine dry-run on daily data. */
  private async validate(versions: BasketVersion[], baseValue: number): Promise<{ units: UnitsResult; stale: boolean }> {
    try {
      validateVersions(versions, { now: this.now() });
    } catch (err) {
      if (err instanceof BasketValidationError) throw invalid(err.message);
      throw err;
    }
    for (const id of constituents(versions)) {
      try {
        await this.market.symbolInfo(id);
      } catch (err) {
        if (err instanceof NotFoundError) throw invalid(`Unknown symbol ${id}`);
        throw err;
      }
    }
    return this.computeUnits(versions, baseValue, 'save');
  }

  /** Daily data for every constituent from v0 − 10 d to now, then the engine. */
  private async computeUnits(versions: BasketVersion[], baseValue: number, mode: 'save' | 'read'): Promise<{ units: UnitsResult; stale: boolean }> {
    const from = parseDateString(versions[0]!.effectiveFrom) - UNITS_LOOKBACK_MS;
    const to = this.now() + DAY;
    const ids = constituents(versions);
    const results = await Promise.all(ids.map((id) => this.market.getNativeBars(id, '1D', from, to)));
    const daily: Record<SymbolId, Bar[]> = {};
    ids.forEach((id, i) => { daily[id] = results[i]!.bars; });
    const stale = results.some((r) => r.stale);
    try {
      return { units: computeVersionUnits(versions, daily, baseValue), stale };
    } catch (err) {
      // On save a failure is the user's input; on read the basket was valid when saved, so it's missing data.
      if (err instanceof BasketValidationError) throw stale || mode === 'read' ? unavailable() : invalid(err.message);
      throw err;
    }
  }

  private seed(id: string, versions: BasketVersion[], r: { units: UnitsResult; stale: boolean }): void {
    if (!r.stale) this.unitsCache.set(id, { key: JSON.stringify(versions), units: r.units, at: this.now() });
  }

  private async unitsFor(basket: Basket): Promise<{ units: UnitsResult; stale: boolean }> {
    const key = JSON.stringify(basket.versions);
    const hit = this.unitsCache.get(basket.id);
    const now = this.now();
    if (hit && hit.key === key) {
      const yesterday = Math.floor(now / DAY) * DAY - DAY;
      const recent = basket.versions.some((v) => parseDateString(v.effectiveFrom) >= yesterday);
      if (!(recent && now - hit.at > UNITS_TTL_MS)) return { units: hit.units, stale: false };
    }
    let r: { units: UnitsResult; stale: boolean };
    try {
      r = await this.computeUnits(basket.versions, basket.baseValue, 'read');
    } catch (err) {
      // A refresh that fails (e.g. provider outage) falls back to the expired units for the same versions.
      if (hit && hit.key === key) return { units: hit.units, stale: true };
      throw err;
    }
    if (r.stale && hit && hit.key === key) return { units: hit.units, stale: true };
    this.seed(basket.id, basket.versions, r);
    return r;
  }
}

import { randomUUID } from 'node:crypto';
import {
  BasketValidationError, alignUnitsToNySessions, baseTimeframe, basketQuoteExt, bucketStart, buildBasketBars,
  computeVersionUnits, filterSession, isIntraday, nyDateUtcMidnight, parseDateString, parseSymbolId, resample, tfMs, utcDateString, validateVersions, versionMarkers,
  type Bar, type Basket, type BasketVersion, type Calendar, type ConstituentSeries, type Marker, type Quote,
  type SessionMode, type SymbolId, type Timeframe, type UnitsResult,
} from '@chartmate/shared';
import type { Repos } from '../db/repos.js';
import { AppError, NotFoundError } from '../errors.js';
import { bucketEnd } from '../market/buckets.js';
import type { MarketDataService } from '../market/service.js';

const DAY = 86_400_000;
const UNITS_TTL_MS = 6 * 3_600_000;
/** Longest reuse of provisional units (a version dated tomorrow sized at today's unfinished daily bar). */
const PROVISIONAL_UNITS_TTL_MS = 5 * 60_000;
const INTRADAY_PAD_MS = 5 * DAY;
/** getLatest's intraday pad for baskets holding a stock: covers a long weekend so forward-fill has a prior close. */
const LATEST_STOCK_PAD_MS = 4 * DAY;
const DAILY_PAD_MS = 10 * DAY;
const UNITS_LOOKBACK_MS = 10 * DAY;
/** Daily history used for a basket quote's previous close (and the fallback quote). */
const QUOTE_LOOKBACK_MS = 10 * DAY;
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

/** `until`: provisional units (sized at a daily bar still trading) or units kept through a failed refresh (`stale`)
 * expire then; others follow UNITS_TTL_MS. */
interface CachedUnits { key: string; units: UnitsResult; at: number; until?: number; stale?: boolean }
/** The basket's two latest daily closes, computed once per UTC day per basket (key = units key). */
interface CachedDaily { key: string; day: number; last: Bar | null; prev: Bar | null }

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

export class BasketService {
  private readonly repos: Repos;
  private readonly market: MarketDataService;
  private readonly now: () => number;
  private readonly unitsCache = new Map<string, CachedUnits>();
  private readonly dailyCache = new Map<string, CachedDaily>();
  private rev = 0;

  constructor(deps: { repos: Repos; market: MarketDataService; now?: () => number }) {
    this.repos = deps.repos;
    this.market = deps.market;
    this.now = deps.now ?? Date.now;
  }

  /** Bumped on every basket create/update/delete; callers key short-lived caches on it. */
  get revision(): number {
    return this.rev;
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
    this.rev++;
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
    this.rev++;
    if (clean.versions && dry) {
      this.unitsCache.delete(id);
      this.dailyCache.delete(id);
      this.seed(id, clean.versions, dry);
    }
    return updated;
  }

  /**
   * Validates the versions with `v` appended, then appends it in one repo transaction that first checks the stored
   * versions are still the validated ones. A concurrent edit in between is retried (twice) against the new list,
   * then reported as 409 conflict: two appends can never overwrite each other.
   */
  async appendVersion(id: string, v: BasketVersion): Promise<Basket> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.get(id);
      const versions = [...current.versions, v];
      const dry = await this.validate(versions, current.baseValue);
      const r = await this.repos.baskets.appendVersion(id, v, current.versions);
      if (r === null) throw new NotFoundError(`Basket ${id} not found`);
      if (r !== 'conflict') {
        this.rev++;
        this.unitsCache.delete(id);
        this.dailyCache.delete(id);
        this.seed(id, r.versions, dry);
        return r;
      }
      if (attempt >= 2) throw new AppError(409, 'conflict', 'The basket changed while saving; try again');
    }
  }

  async delete(id: string): Promise<void> {
    this.unitsCache.delete(id);
    this.dailyCache.delete(id);
    if (!(await this.repos.baskets.delete(id))) throw new NotFoundError(`Basket ${id} not found`);
    this.rev++;
  }

  async getBars(a: BasketBarsArgs): Promise<BarsResponseCore> {
    const { unseeded: _u, realInWindow: _r, ...core } = await this.buildBars(a);
    return core;
  }

  /**
   * getBars plus: the constituents (of the version active at the window start) with no bar inside the pad, and
   * whether any fetched series has a real bar inside [from, to).
   */
  private async buildBars(a: BasketBarsArgs): Promise<BarsResponseCore & { unseeded: SymbolId[]; realInWindow: boolean }> {
    const basket = await this.get(a.id);
    const { units: dailyUnits, stale: unitsStale } = await this.unitsFor(basket);
    const all = constituents(basket.versions);
    const anyCrypto = all.some((id) => parseSymbolId(id).assetClass === 'crypto');
    // Stock-only intraday: the start and each version switch at the start of the NY session, not 00:00 UTC.
    const units = isIntraday(a.tf) && !anyCrypto ? alignUnitsToNySessions(dailyUnits) : dailyUnits;
    const S = units.startTs;
    const markers: Marker[] = [
      ...(S >= a.from && S < a.to ? [{ ts: S, label: START_MARKER }] : []),
      ...versionMarkers(units).filter((m) => m.ts >= a.from && m.ts < a.to),
    ];
    const notices = [...units.notices];
    if (isIntraday(a.tf)) notices.push(INTRADAY_HL_NOTICE);

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

    let active = vs[0]!;
    for (const ver of vs) if (ver.effectiveTs <= baseFrom) active = ver;
    const unseeded = Object.keys(active.units)
      .filter((id) => !(fetched.find((f) => f.id === id)?.bars.some((b) => b.ts < baseFrom) ?? false));
    const realInWindow = fetched.some((f) => f.bars.some((b) => b.ts >= a.from && b.ts < a.to));

    return {
      unseeded,
      realInWindow,
      bars,
      stale: unitsStale || fetched.some((s) => s.stale),
      // Unknown history (no earliest for any constituent): keep paging while pages still have bars.
      hasMoreBefore: floor === -Infinity ? bars.length > 0 : a.from > floor,
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
    // 1D looks back a week so a stock basket's last session is found over a (long) weekend.
    const back = tf === '1D' || tf === '1W' ? 7 * DAY : tf === '1M' ? 31 * DAY : tfMs(tf);
    // Polled often: fetch just enough history to seed forward-fill (stocks: across a long weekend).
    const base = baseTimeframe(tf);
    const padMs = !isIntraday(base) ? undefined : classes.includes('stock') ? LATEST_STOCK_PAD_MS : 2 * tfMs(base);
    const args = { id, tf, session, from: bucketStart(now, tf, cal) - back, to: now + tfMs(tf) };
    let r = await this.buildBars(padMs !== undefined ? { ...args, padMs } : args);
    // The small pad can miss a constituent's last close (e.g. a halt or long closure): retry with the full pad, but
    // only when that could change the answer (an empty off-hours window must not double provider traffic).
    const retry = r.unseeded.length > 0 || (r.bars.length === 0 && r.realInWindow);
    if (padMs !== undefined && retry) r = await this.buildBars(args);
    return { bar: r.bars.at(-1) ?? null, stale: r.stale };
  }

  /**
   * Quotes for baskets (by uuid) plus plain market ids, with ONE batched `market.quotes` call for the market ids and
   * every basket's current constituents. A basket's price is Σ unitsᵢ × quoteᵢ.price with the version active now;
   * changePct is against the basket's previous daily close (two latest daily closes cached once per UTC day per
   * basket, invalidated on update). Constituent prices are their REGULAR ones, so price/changePct stay a consistent
   * pair; while any stock constituent trades pre/post-market, `ext` holds the basket's extended value (see
   * basketQuoteExt). When any constituent quote is missing (or units can't be had) the basket falls
   * back to its latest daily bar. Baskets that fail entirely are omitted.
   */
  async liveQuotes(basketIds: string[], marketIds: SymbolId[]): Promise<{ market: Quote[]; baskets: Quote[] }> {
    const plans = await Promise.all(basketIds.map(async (id) => {
      try {
        const basket = await this.get(id);
        const { units: dailyUnits } = await this.unitsFor(basket);
        // Stock-only: a version takes over at the next NY session's start, as on intraday charts (the eve's winter
        // post-market runs past 00:00 UTC on the old units).
        const stockOnly = constituents(basket.versions).every((c) => parseSymbolId(c).assetClass === 'stock');
        const units = stockOnly ? alignUnitsToNySessions(dailyUnits) : dailyUnits;
        const now = this.now();
        let active = units.versions[0]!;
        for (const ver of units.versions) if (ver.effectiveTs <= now) active = ver;
        return { id, basket, units: active.units, key: this.unitsKey(basket.versions) };
      } catch {
        return { id, basket: null, units: null, key: '' };
      }
    }));
    const wanted = new Set<SymbolId>(marketIds);
    for (const p of plans) if (p.units) for (const c of Object.keys(p.units)) wanted.add(c);
    let quotes: Quote[] = [];
    if (wanted.size > 0) {
      try {
        quotes = await this.market.quotes([...wanted]);
      } catch {
        quotes = []; // baskets fall back to daily bars; the market part is omitted
      }
    }
    const byId = new Map(quotes.map((q) => [q.id, q]));
    const marketSet = new Set(marketIds);
    const basketQuotes = await Promise.all(plans.map(async (p): Promise<Quote | null> => {
      try {
        if (p.basket && p.units) {
          const live = this.priceFromQuotes(p.units, byId);
          if (live) {
            const d = await this.dailyCloses(p.id, p.key);
            // The session date of the price: NY date for stock-only baskets (their daily bars are NY trading dates;
            // a post-market price after 20:00 EDT is still that session), UTC date when crypto sets the daily grid.
            const anyCrypto = Object.keys(p.units).some((c) => parseSymbolId(c).assetClass === 'crypto');
            const quoteDay = anyCrypto ? Math.floor(live.ts / DAY) * DAY : nyDateUtcMidnight(live.ts);
            // Before the latest daily bar's day closes, compare with the bar before it; once a newer day trades,
            // the latest bar is the previous close.
            const prev = d.last && quoteDay > d.last.ts ? d.last : d.prev;
            const changePct = prev && prev.close !== 0 ? ((live.price - prev.close) / prev.close) * 100 : null;
            // Extended hours: constituents at their pre/post prices (others at their regular/live price), vs this value.
            const ext = basketQuoteExt(p.units, byId, live.price);
            return { id: `basket:${p.id}`, price: live.price, changePct, ts: live.ts, ...(ext ? { ext } : {}) };
          }
        }
        return await this.dailyQuote(p.id);
      } catch {
        return null;
      }
    }));
    return {
      market: quotes.filter((q) => marketSet.has(q.id)),
      baskets: basketQuotes.filter((q): q is Quote => q !== null),
    };
  }

  private priceFromQuotes(units: Record<SymbolId, number>, byId: Map<SymbolId, Quote>): { price: number; ts: number } | null {
    let price = 0;
    let ts = -Infinity;
    for (const [c, u] of Object.entries(units)) {
      const q = byId.get(c);
      if (!q || !Number.isFinite(q.price)) return null;
      price += u * q.price;
      ts = Math.max(ts, q.ts);
    }
    // A provider stamp in the future (e.g. a day-end closeTime) must not move the quote into the next day.
    ts = Math.min(ts, this.now());
    return Number.isFinite(price) && Number.isFinite(ts) ? { price, ts } : null;
  }

  /** The basket's two latest daily bars (cached once per UTC day per basket and units key). */
  private async dailyCloses(id: string, key: string): Promise<CachedDaily> {
    const now = this.now();
    const day = Math.floor(now / DAY) * DAY;
    const hit = this.dailyCache.get(id);
    if (hit && hit.key === key && hit.day === day) return hit;
    const r = await this.getBars({ id, tf: '1D', session: 'rth', from: now - QUOTE_LOOKBACK_MS, to: now + DAY });
    const entry: CachedDaily = { key, day, last: r.bars.at(-1) ?? null, prev: r.bars.at(-2) ?? null };
    if (!r.stale) this.dailyCache.set(id, entry);
    return entry;
  }

  /** Fallback quote from the latest daily bars: price = last close, change vs the previous close. */
  private async dailyQuote(id: string): Promise<Quote | null> {
    const now = this.now();
    const r = await this.getBars({ id, tf: '1D', session: 'rth', from: now - QUOTE_LOOKBACK_MS, to: now + DAY });
    const last = r.bars.at(-1);
    if (!last) return null;
    const prev = r.bars.at(-2);
    const changePct = prev && prev.close !== 0 ? ((last.close - prev.close) / prev.close) * 100 : null;
    return { id: `basket:${id}`, price: last.close, changePct, ts: last.ts };
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
    const staleIds = new Set<SymbolId>();
    ids.forEach((id, i) => {
      daily[id] = results[i]!.bars;
      if (results[i]!.stale) staleIds.add(id);
    });
    const stale = staleIds.size > 0;
    try {
      return { units: computeVersionUnits(versions, daily, baseValue), stale };
    } catch (err) {
      if (!(err instanceof BasketValidationError)) throw err;
      // On read the basket was valid when saved, so a failure is missing data. On save it is the user's input,
      // unless the constituent lacking data was itself fetched stale and its (cached) series is empty or has no
      // close before the date one was needed: then it is an outage.
      if (mode === 'read') throw unavailable();
      const id = err.symbol;
      if (id !== undefined && staleIds.has(id)) {
        const bars = daily[id] ?? [];
        const lacking = bars.length === 0 || err.needTs === undefined || !(bars[0]!.ts < err.needTs);
        if (lacking) throw unavailable();
      }
      throw invalid(err.message);
    }
  }

  /** Units-cache key: the versions plus the market cache epoch (bumped when a split invalidates cached bars). */
  private unitsKey(versions: BasketVersion[]): string {
    return `${this.market.cacheEpoch}|${JSON.stringify(versions)}`;
  }

  private seed(id: string, versions: BasketVersion[], r: { units: UnitsResult; stale: boolean }): void {
    if (r.stale) return;
    const now = this.now();
    // A version (or the start) dated tomorrow is sized at today's daily bar, which is still trading: those units
    // are provisional. Keep them briefly (no provider call per request) and recompute once that day has closed.
    const next = Math.min(...r.units.versions.map((v) => v.effectiveTs).filter((ts) => ts > now));
    const until = next === Infinity ? undefined : Math.min(next, now + PROVISIONAL_UNITS_TTL_MS);
    this.unitsCache.set(id, { key: this.unitsKey(versions), units: r.units, at: now, ...(until !== undefined ? { until } : {}) });
  }

  /** Keeps expired units through a failed refresh for a few minutes, so an outage is not retried per request. */
  private keepStale(id: string, hit: CachedUnits): { units: UnitsResult; stale: true } {
    const now = this.now();
    this.unitsCache.set(id, { ...hit, until: now + PROVISIONAL_UNITS_TTL_MS, stale: true });
    return { units: hit.units, stale: true };
  }

  private async unitsFor(basket: Basket): Promise<{ units: UnitsResult; stale: boolean }> {
    // Run the (at most daily) split checks first so a split detected now invalidates the cached units right away.
    await Promise.all(constituents(basket.versions).map((id) => this.market.ensureSplitsChecked(id)));
    const key = this.unitsKey(basket.versions);
    const hit = this.unitsCache.get(basket.id);
    const now = this.now();
    if (hit && hit.key === key && hit.until !== undefined) {
      if (now < hit.until) return { units: hit.units, stale: hit.stale === true };
    } else if (hit && hit.key === key) {
      const yesterday = Math.floor(now / DAY) * DAY - DAY;
      const recent = basket.versions.some((v) => parseDateString(v.effectiveFrom) >= yesterday);
      if (!(recent && now - hit.at > UNITS_TTL_MS)) return { units: hit.units, stale: false };
    }
    let r: { units: UnitsResult; stale: boolean };
    try {
      r = await this.computeUnits(basket.versions, basket.baseValue, 'read');
    } catch (err) {
      // A refresh that fails (e.g. provider outage) falls back to the expired units for the same versions.
      if (hit && hit.key === key) return this.keepStale(basket.id, hit);
      throw err;
    }
    if (r.stale && hit && hit.key === key) return this.keepStale(basket.id, hit);
    this.seed(basket.id, basket.versions, r);
    return r;
  }
}

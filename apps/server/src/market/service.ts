import {
  baseTimeframe, bucketStart, filterSession, isIntraday, nyParts, nyToUtc, parseSymbolId, resample, tfMs,
  type AssetClass, type Bar, type Calendar, type NativeTimeframe, type Quote, type SessionMode,
  type SymbolId, type SymbolInfo, type Timeframe,
} from '@chartmate/shared';
import type { Repos, SplitOp, SymbolInfoRow } from '../db/repos.js';
import { AppError, NotFoundError, ProviderError } from '../errors.js';
import { RequestQueue } from '../providers/queue.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { MarketDataProvider } from '../providers/types.js';
import { bucketEnd } from './buckets.js';
import { mergeRanges, missingRanges, splitRange } from './coverage.js';

const DAY = 86_400_000;
const BACKOFF_MS = 30_000;
const SYMBOL_TTL_MS = 7 * DAY;
/** Retry window for a row whose listing-date lookup failed. */
const SYMBOL_RETRY_MS = 60 * 60_000;
/** How long an unknown symbol id is remembered. */
const NEGATIVE_TTL_MS = 10 * 60_000;
/** Most unknown ids remembered at once. */
const MAX_UNKNOWN = 1000;
/** Most symbols tracked at once by the in-memory split bookkeeping (oldest dropped first). */
const MAX_TRACKED = 10_000;
/** A provider "no data" answer for a chunk ending longer ago than this is trusted (cached as empty). */
const NO_DATA_TRUST_MS = 7 * DAY;
/** Stock splits are checked at most this often per symbol. */
const SPLIT_CHECK_MS = DAY;
/** Retry delay after a failed split lookup. */
const SPLIT_RETRY_MS = 60 * 60_000;
/** Never-checked rows (pre-migration): splits older than updated_at - this are assumed reflected in the cache. */
const SPLIT_BASELINE_SLACK_MS = 7 * DAY;
/** How far before the last check a split may be dated and still be reported for the first time. */
const SPLIT_LATE_REPORT_MS = 7 * DAY;
const INTRADAY_NATIVE: NativeTimeframe[] = ['1m', '5m', '15m', '30m', '1h'];

export interface GetBarsArgs { symbol: SymbolId; tf: Timeframe; session: SessionMode; from: number; to: number }
export interface BarsResult { bars: Bar[]; stale: boolean; hasMoreBefore: boolean; earliestTs: number | null; notices: string[] }

type MarketClass = 'stock' | 'crypto';

export function calendarFor(symbol: SymbolId, session: SessionMode): Calendar {
  if (symbol.startsWith('crypto:')) return 'utc';
  return session === 'rth' ? 'nyse-rth' : 'nyse-eth';
}

/**
 * Whether [from, to) overlaps a trading session: always for crypto (it trades around the clock); for stocks, a
 * weekday (Mon–Fri) daily bar, or intraday a weekday's 04:00–20:00 New York extended session. Holidays count as
 * sessions (no calendar here), so an empty holiday is simply asked again until it is a week old.
 */
export function holdsSession(assetClass: MarketClass, tf: NativeTimeframe, from: number, to: number): boolean {
  if (from >= to) return false;
  if (assetClass === 'crypto') return true;
  if (to - from > 5 * DAY) return true;
  if (tf === '1D') {
    for (let d = Math.ceil(from / DAY) * DAY; d < to; d += DAY) {
      const dow = new Date(d).getUTCDay();
      if (dow !== 0 && dow !== 6) return true;
    }
    return false;
  }
  for (let t = from - DAY; t < to + DAY; t += DAY) {
    const { y, m, d, dow } = nyParts(t);
    if (dow === 0 || dow === 6) continue;
    if (nyToUtc(y, m, d, 4, 0) < to && nyToUtc(y, m, d, 20, 0) > from) return true;
  }
  return false;
}

function parseMarketSymbol(id: SymbolId): { assetClass: MarketClass; code: string } {
  let parsed: { assetClass: AssetClass; code: string };
  try {
    parsed = parseSymbolId(id);
  } catch {
    throw new AppError(400, 'invalid_symbol', `Invalid symbol ${id}`);
  }
  if (parsed.assetClass === 'basket') throw new AppError(400, 'invalid_symbol', `Basket symbols are not market data: ${id}`);
  return { assetClass: parsed.assetClass, code: parsed.code };
}

/** Wraps a non-ProviderError upstream failure (e.g. network TypeError) as a retryable ProviderError; NotFound/AppErrors pass through. */
function asProviderError(provider: string, err: unknown): unknown {
  if (err instanceof ProviderError || err instanceof AppError) return err;
  return new ProviderError(provider, `request failed: ${err instanceof Error ? err.message : String(err)}`, true);
}

export class MarketDataService {
  private readonly repos: Repos;
  private readonly registry: ProviderRegistry;
  private readonly now: () => number;
  private readonly queues: { stock: RequestQueue; crypto: RequestQueue };
  /** Unknown symbol ids → expiry (ms). */
  private readonly unknownUntil = new Map<SymbolId, number>();
  /** Bumped whenever cached bars are invalidated (stock split); dependents (basket units) key their caches on it. */
  private epoch = 0;
  /** Earliest time the next split check may run, per symbol (in-memory; the DB stamp survives restarts). */
  private readonly splitNextCheck = new Map<SymbolId, number>();
  private readonly splitChecks = new Map<SymbolId, Promise<void>>();
  /** Stocks seen by this process with neither a symbols row nor cached bars: their bars are fetched from then on. */
  private readonly freshSymbols = new Set<SymbolId>();

  /** Most symbols the in-memory split bookkeeping tracks at once. */
  private readonly maxTracked: number;

  constructor(deps: {
    repos: Repos; registry: ProviderRegistry; now?: () => number; queues?: { stock: RequestQueue; crypto: RequestQueue };
    maxTracked?: number;
  }) {
    this.repos = deps.repos;
    this.maxTracked = deps.maxTracked ?? MAX_TRACKED;
    this.registry = deps.registry;
    this.now = deps.now ?? Date.now;
    this.queues = deps.queues ?? {
      stock: new RequestQueue({ concurrency: 2, minIntervalMs: 250 }),
      crypto: new RequestQueue({ concurrency: 4, minIntervalMs: 100 }),
    };
  }

  async getBars(a: GetBarsArgs): Promise<BarsResult> {
    const { assetClass } = parseMarketSymbol(a.symbol);
    const base = baseTimeframe(a.tf);
    const derived = a.tf !== base;
    const cal: Calendar = isIntraday(a.tf) ? calendarFor(a.symbol, a.session) : 'utc';
    // A derived bucket starting before `to` needs its natives up to the bucket's end.
    const nativeTo = derived && a.to > a.from ? Math.max(a.to, bucketEnd(a.to - 1, a.tf, cal)) : a.to;

    const [native, earliestTs] = await Promise.all([
      this.getNativeBars(a.symbol, base, a.from, nativeTo),
      this.earliest(a.symbol, a.tf),
    ]);

    let bars = native.bars;
    if (assetClass === 'stock' && isIntraday(base)) bars = filterSession(bars, a.session);
    if (derived) bars = resample(bars, a.tf, cal);
    bars = bars.filter((b) => b.ts >= a.from && b.ts < a.to);

    const notices: string[] = [];
    const lookback = this.provider(assetClass).limits.maxLookbackMs[base];
    if (lookback !== undefined && a.from < this.now() - lookback) {
      notices.push(`Free data source limits ${a.tf} history to ~${Math.round(lookback / DAY)} days.`);
    }
    const hasMoreBefore = earliestTs === null ? bars.length > 0 : a.from > earliestTs;
    return { bars, stale: native.stale, hasMoreBefore, earliestTs, notices };
  }

  /** Changes whenever cached market data was invalidated (see `ensureSplitsChecked`). */
  get cacheEpoch(): number {
    return this.epoch;
  }

  /**
   * Stock-split check, at most once per day per stock symbol (stamped in `symbols.splits_checked_at`; new rows are
   * stamped on insert, symbols with neither row nor bars are remembered in memory). Yahoo's history is adjusted as of
   * fetch time, so for each split since the last check (and not in the future): daily bars are dropped, intraday bars
   * still inside the provider lookback are dropped (refetchable), and older intraday bars are rescaled by the split
   * factor; this and the new stamp commit in one transaction, then `cacheEpoch` is bumped (basket units recompute).
   * Rows that were never checked (pre-migration) use `updated_at − 7 d` as the baseline. Never throws: a failed
   * lookup backs the stock queue off (if retryable) and is retried after an hour. Concurrent callers share one check.
   */
  async ensureSplitsChecked(symbol: SymbolId): Promise<void> {
    let parsed: { assetClass: MarketClass; code: string };
    try {
      parsed = parseMarketSymbol(symbol);
    } catch {
      return;
    }
    if (parsed.assetClass !== 'stock' || !this.provider('stock').splitsSince) return;
    const next = this.splitNextCheck.get(symbol);
    if (next !== undefined && this.now() < next) return;
    const pending = this.splitChecks.get(symbol);
    if (pending) return pending;
    const p = this.checkSplits(symbol, parsed.code).finally(() => this.splitChecks.delete(symbol));
    this.splitChecks.set(symbol, p);
    return p;
  }

  private async checkSplits(symbol: SymbolId, code: string): Promise<void> {
    const provider = this.provider('stock');
    const now = this.now();
    try {
      const row = await this.repos.symbols.get(symbol);
      if (!row) {
        // Nothing cached -> nothing to invalidate: remember "checked now" (the row insert stamps the DB later).
        // Cached bars without a row: try again later (the row normally appears with the first symbolInfo).
        const cached = await this.repos.bars.hasAny(symbol);
        if (!cached) this.rememberFresh(symbol);
        this.setNextCheck(symbol, now + (cached ? SPLIT_RETRY_MS : SPLIT_CHECK_MS));
        return;
      }
      const last = row.splitsCheckedAt ?? null;
      if (last !== null && now - last < SPLIT_CHECK_MS) {
        this.setNextCheck(symbol, last + SPLIT_CHECK_MS);
        return;
      }
      // Rows from before split checks existed: splits older than the row's refresh (minus slack) are already
      // reflected in what was cached.
      const since = last ?? row.updatedAt - SPLIT_BASELINE_SLACK_MS;
      // Look back past the last check too: a split may be reported a few days after its date. Never past the start
      // of the applied-split record, since an earlier version may have applied older splits without recording them.
      const trackedFrom = row.splitsTrackedFrom ?? null;
      const lookFrom = trackedFrom === null ? since : Math.max(since - SPLIT_LATE_REPORT_MS, Math.min(trackedFrom, since));
      const [splits, applied] = await Promise.all([
        this.queues.stock.run(`splits|${code}|${lookFrom}`, () => provider.splitsSince!(code, lookFrom)),
        this.repos.symbols.appliedSplits(symbol),
      ]);
      // Only splits that already happened (a future-dated, announced event is applied once it has occurred), and
      // each one once.
      const relevant = splits.filter((sp) => sp.ts > lookFrom && sp.ts <= now && !applied.has(sp.ts)).sort((x, y) => x.ts - y.ts);
      if (relevant.length > 0) {
        // Stamps and records the splits in the same transaction.
        await this.repos.bars.applySplit(symbol, this.splitOps(relevant), now, relevant.map((sp) => sp.ts));
        this.epoch++;
      } else {
        await this.repos.symbols.markSplitsChecked(symbol, now);
      }
      this.setNextCheck(symbol, now + SPLIT_CHECK_MS);
    } catch (err) {
      if (err instanceof ProviderError && err.retryable && err.provider !== 'queue') this.queues.stock.backoff(BACKOFF_MS);
      this.setNextCheck(symbol, now + SPLIT_RETRY_MS); // never fail a bars request over this
    }
  }

  /**
   * Per split at X (ascending): daily bars are dropped (refetchable in full). For each intraday timeframe with
   * lookback L, bars at ts >= X - L are still refetchable and are dropped; older bars were necessarily fetched before
   * X (they had left the provider's window before the split), so they are kept and rescaled by the split factor.
   * Without a lookback limit (or a known factor) the whole timeframe is dropped.
   */
  private splitOps(splits: { ts: number; factor?: number }[]): SplitOp[] {
    const limits = this.provider('stock').limits.maxLookbackMs;
    const ops: SplitOp[] = [{ tf: '1D', cut: Number.MIN_SAFE_INTEGER }];
    for (const sp of splits) {
      const factor = sp.factor !== undefined && Number.isFinite(sp.factor) && sp.factor > 0 ? sp.factor : undefined;
      for (const tf of INTRADAY_NATIVE) {
        const L = limits[tf];
        if (L === undefined || factor === undefined) ops.push({ tf, cut: Number.MIN_SAFE_INTEGER });
        else ops.push({ tf, cut: sp.ts - L, factor });
      }
    }
    return ops;
  }

  async getNativeBars(symbol: SymbolId, tf: NativeTimeframe, from: number, to: number): Promise<{ bars: Bar[]; stale: boolean }> {
    const { assetClass, code } = parseMarketSymbol(symbol);
    // A symbol the provider just said it does not know is not asked for bars again until the entry expires.
    if (this.isRememberedUnknown(symbol)) throw new NotFoundError(`Unknown symbol ${symbol}`);
    if (assetClass === 'stock') await this.ensureSplitsChecked(symbol);
    const provider = this.provider(assetClass);
    const queue = this.queues[assetClass];
    const now = this.now();
    const step = tfMs(tf);

    // Fetch and record coverage on the native grid (1D → UTC midnight): a bar whose ts lies before a
    // non-aligned `from` (e.g. a daily bar stamped 00:00 requested from 10:00Z) must not be skipped while
    // its range is marked covered. Grid-aligned bounds also keep dedupe keys stable as the clock moves.
    const floorGrid = (x: number) => Math.floor(x / step) * step;
    const outFrom = from;
    const outTo = to;
    from = floorGrid(from);
    to = Math.ceil(to / step) * step;
    const lookback = provider.limits.maxLookbackMs[tf];
    if (lookback !== undefined) from = Math.max(from, Math.ceil((now - lookback) / step) * step);
    to = Math.min(to, floorGrid(now + step));
    if (from >= to) return { bars: [], stale: false };

    const recentEdge = floorGrid(tf === '1D' ? now - 3 * DAY : now - 2 * step);
    const covered = await this.repos.coverage.list(symbol, tf);
    const gaps = missingRanges(covered, from, Math.min(to, recentEdge));
    const recentFrom = Math.max(from, recentEdge);
    if (recentFrom < to) gaps.push([recentFrom, to]);
    const span = provider.limits.maxSpanPerRequestMs[tf];
    const chunks = mergeRanges(gaps).flatMap(([a, b]) => splitRange(a, b, span));

    const markCovered = async (gapFrom: number, gapTo: number) => {
      const coveredTo = Math.min(gapTo, recentEdge);
      if (gapFrom < coveredTo) await this.repos.coverage.add(symbol, tf, gapFrom, coveredTo);
    };
    const results = await Promise.allSettled(chunks.map(([gapFrom, gapTo]) =>
      queue.run(`${symbol}|${tf}|${gapFrom}|${gapTo}`, async () => {
        let fetched;
        try {
          fetched = await provider.fetchBars(code, tf, gapFrom, gapTo);
        } catch (err) {
          const e = asProviderError(provider.id, err);
          // Cool down at once so this request's remaining queued chunks fail fast instead of hammering upstream.
          if (e instanceof ProviderError && e.retryable && e.provider !== 'queue') queue.backoff(BACKOFF_MS);
          throw e;
        }
        const coveredTo = Math.min(gapTo, recentEdge);
        // An empty answer is only trusted when it cannot be an upstream hiccup (see trustEmpty): otherwise the gap
        // stays uncovered and is asked again next time.
        const cover = fetched.bars.length > 0 || await this.trustEmpty(symbol, assetClass, tf, gapFrom, coveredTo, now);
        await this.repos.bars.store(symbol, tf, fetched.bars, cover ? [gapFrom, coveredTo] : null);
      })));

    let stale = false;
    const notFound: Array<[number, number]> = [];
    let firstNotFound: NotFoundError | null = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') continue;
      const err: unknown = r.reason;
      if (err instanceof NotFoundError) {
        notFound.push(chunks[i]!);
        if (firstNotFound === null) firstNotFound = err;
        continue;
      }
      if (!(err instanceof ProviderError)) throw err; // internal failures propagate
      stale = true; // the cooldown was already applied where the fetch failed
    }

    if (firstNotFound !== null) {
      // Providers report "no data" as NotFound for valid symbols too (e.g. a pre-listing window).
      // For a known symbol such a chunk is simply empty; only an unknown symbol is a 404.
      const known = await this.isKnown(symbol, tf);
      // The provider's own wording stays server-side (logged by the app's error handler from `cause`).
      if (known === false) throw new NotFoundError(`Unknown symbol ${symbol}`, { cause: firstNotFound });
      if (known === null) {
        stale = true; // couldn't tell (lookup outage): serve the DB, don't mark coverage
      } else {
        // Only trust "no data" when it cannot be a transient upstream hiccup: the chunk ends before the listing
        // date, or long enough ago. Otherwise leave it uncovered (retried next time) and report stale.
        const firstTs = (await this.repos.symbols.get(symbol))?.firstTs ?? null;
        for (const [a, b] of notFound) {
          // The recent tail (>= recentEdge) is never covered and is refetched anyway: "no data" there is normal.
          const low = Math.min(b, recentEdge);
          if (a >= low) continue;
          if ((firstTs !== null && low <= firstTs) || low < now - NO_DATA_TRUST_MS) await markCovered(a, low);
          else stale = true;
        }
      }
    }
    return { bars: await this.repos.bars.range(symbol, tf, Math.max(from, outFrom), Math.min(to, outTo)), stale };
  }

  async getLatest(symbol: SymbolId, tf: Timeframe, session: SessionMode): Promise<{ bar: Bar | null; stale: boolean }> {
    const now = this.now();
    const cal = isIntraday(tf) ? calendarFor(symbol, session) : 'utc';
    const back = tf === '1W' ? 7 * DAY : tf === '1M' ? 31 * DAY : tfMs(tf);
    const r = await this.getBars({ symbol, tf, session, from: bucketStart(now, tf, cal) - back, to: now + tfMs(tf) });
    return { bar: r.bars.at(-1) ?? null, stale: r.stale };
  }

  /** max(listing date, now − provider lookback for the base timeframe); null if neither is known. Never throws for lookup failures. */
  async earliest(symbol: SymbolId, tf: Timeframe): Promise<number | null> {
    const { assetClass } = parseMarketSymbol(symbol);
    const lookback = this.provider(assetClass).limits.maxLookbackMs[baseTimeframe(tf)];
    let firstTs: number | null = null;
    try {
      await this.symbolInfo(symbol);
      firstTs = (await this.repos.symbols.get(symbol))?.firstTs ?? null;
    } catch {
      firstTs = null; // unknown listing date; bars requests must not fail on metadata lookups
    }
    const fromLookback = lookback === undefined ? null : this.now() - lookback;
    if (firstTs === null && fromLookback === null) return null;
    return Math.max(firstTs ?? -Infinity, fromLookback ?? -Infinity);
  }

  async search(q: string): Promise<SymbolInfo[]> {
    const [stocks, cryptos] = await Promise.allSettled([this.searchClass('stock', q), this.searchClass('crypto', q)]);
    if (stocks.status === 'rejected' && cryptos.status === 'rejected') {
      const reason = stocks.reason;
      throw reason instanceof ProviderError ? reason : new ProviderError('search', 'symbol search unavailable', true);
    }
    const s = stocks.status === 'fulfilled' ? stocks.value : [];
    const c = cryptos.status === 'fulfilled' ? cryptos.value : [];
    const needle = q.trim().toUpperCase();
    const cryptoFirst = needle !== '' && c.some((x) => x.ticker.toUpperCase() === needle);
    const seen = new Set<string>();
    return (cryptoFirst ? [...c, ...s] : [...s, ...c]).filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
  }

  async quotes(ids: SymbolId[]): Promise<Quote[]> {
    const codes: Record<MarketClass, string[]> = { stock: [], crypto: [] };
    for (const id of ids) {
      let p: { assetClass: AssetClass; code: string };
      try {
        p = parseSymbolId(id);
      } catch {
        continue;
      }
      if (p.assetClass !== 'basket' && !codes[p.assetClass].includes(p.code)) codes[p.assetClass].push(p.code);
    }
    const run = async (cls: MarketClass): Promise<Quote[]> => {
      const list = codes[cls];
      if (list.length === 0) return [];
      try {
        return await this.queues[cls].run(`quotes|${list.join(',')}`, () => this.provider(cls).quotes(list));
      } catch (err) {
        // Quotes are polled: a rate limit or outage cools the queue down instead of being retried every poll.
        const e = asProviderError(this.provider(cls).id, err);
        if (e instanceof ProviderError && e.retryable && e.provider !== 'queue') this.queues[cls].backoff(BACKOFF_MS);
        return [];
      }
    };
    const [s, c] = await Promise.all([run('stock'), run('crypto')]);
    return [...s, ...c];
  }

  async symbolInfo(id: SymbolId): Promise<SymbolInfo> {
    const { assetClass, code } = parseMarketSymbol(id);
    const row = await this.repos.symbols.get(id);
    if (row && this.now() - row.updatedAt < SYMBOL_TTL_MS) return toInfo(row, assetClass, code);
    if (!row) {
      const until = this.unknownUntil.get(id);
      if (until !== undefined && this.now() < until) throw new NotFoundError(`Unknown symbol ${id}`);
      this.unknownUntil.delete(id);
    }
    try {
      return await this.refreshSymbol(id, assetClass, code, row);
    } catch (err) {
      if (row) {
        // Best effort: a stale row beats an error. Push the next refresh attempt out by the retry window
        // so an outage doesn't turn every call into an upstream lookup.
        const retryAt = this.now() - SYMBOL_TTL_MS + SYMBOL_RETRY_MS;
        if (row.updatedAt < retryAt) {
          try {
            await this.repos.symbols.upsert({ ...row, updatedAt: retryAt });
          } catch {
            // keep serving the row even if the bump can't be stored
          }
        }
        return toInfo(row, assetClass, code);
      }
      if (err instanceof NotFoundError) this.rememberUnknown(id);
      throw err;
    }
  }

  private isRememberedUnknown(id: SymbolId): boolean {
    const until = this.unknownUntil.get(id);
    return until !== undefined && this.now() < until;
  }

  /** Bounded: beyond `maxTracked` symbols the oldest entry is dropped (it is simply checked against the DB again). */
  private setNextCheck(id: SymbolId, at: number): void {
    const m = this.splitNextCheck;
    m.delete(id); // re-insert so Map order stays oldest-first
    while (m.size >= this.maxTracked) m.delete(m.keys().next().value!);
    m.set(id, at);
  }

  private rememberFresh(id: SymbolId): void {
    if (this.freshSymbols.size >= this.maxTracked) this.freshSymbols.delete(this.freshSymbols.values().next().value!);
    this.freshSymbols.add(id);
  }

  /** Negative-caches an unknown id; the map is capped (expired entries first, then the oldest). */
  private rememberUnknown(id: SymbolId): void {
    const now = this.now();
    const m = this.unknownUntil;
    m.delete(id); // re-insert so Map order stays oldest-first
    if (m.size >= MAX_UNKNOWN) for (const [k, t] of m) if (t <= now) m.delete(k);
    for (const k of m.keys()) {
      if (m.size < MAX_UNKNOWN) break;
      m.delete(k);
    }
    m.set(id, now + NEGATIVE_TTL_MS);
  }

  /**
   * Whether a successful but empty provider answer for [from, to) may be cached as "no bars here": the range ends
   * more than 7 days ago (a late-arriving fix is unlikely), or at/before the symbol's known listing date, or it
   * holds no trading session at all (a stock's weekend or overnight gap). Anything else may be a transient upstream
   * glitch and must not become permanent coverage.
   */
  private async trustEmpty(symbol: SymbolId, assetClass: MarketClass, tf: NativeTimeframe, from: number, to: number, now: number): Promise<boolean> {
    if (from >= to) return false;
    if (to < now - NO_DATA_TRUST_MS) return true;
    if (!holdsSession(assetClass, tf, from, to)) return true;
    const firstTs = (await this.repos.symbols.get(symbol))?.firstTs ?? null;
    return firstTs !== null && to <= firstTs;
  }

  /** true = known symbol, false = unknown (NotFound), null = undetermined (lookup failed). */
  private async isKnown(symbol: SymbolId, tf: NativeTimeframe): Promise<boolean | null> {
    if (await this.repos.bars.lastBefore(symbol, tf, Number.MAX_SAFE_INTEGER)) return true;
    try {
      await this.symbolInfo(symbol);
      return true;
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      return null;
    }
  }

  private async refreshSymbol(id: SymbolId, assetClass: MarketClass, code: string, prev: SymbolInfoRow | null): Promise<SymbolInfo> {
    // Search and listing-date lookup run in parallel (sequential lookups cost two round trips). The lookup is
    // skipped when it only gets its turn after the search already found no match (e.g. a serialized queue).
    // The flag is set inside the queued search task itself, so it is visible before the queue starts the next task.
    let noMatch = false;
    const searchP = this.queues[assetClass].run(`search|${code}`, async () => {
      try {
        const res = await this.provider(assetClass).search(code);
        if (!res.some((r) => r.id === id)) noMatch = true;
        return res;
      } catch (err) {
        noMatch = true;
        throw err;
      }
    });
    const firstP = this.queues[assetClass]
      .run(`first|${code}`, () => (noMatch ? Promise.resolve(null) : this.provider(assetClass).firstBarTs(code)))
      .then((ts): { ok: true; ts: number | null } => ({ ok: true, ts }), () => ({ ok: false as const, ts: null }));
    const results = await searchP;
    const match = results.find((r) => r.id === id);
    if (!match) throw new NotFoundError(`Unknown symbol ${id}`);
    const first = await firstP;
    let firstTs: number | null = first.ts;
    const lookupFailed = !first.ok;
    firstTs ??= prev?.firstTs ?? null;
    const now = this.now();
    const row: SymbolInfoRow = {
      id, name: match.name, exchange: match.exchange ?? null, pricePrecision: match.pricePrecision, firstTs, ticker: match.ticker,
      // A failed listing-date lookup is retried within the hour instead of caching null for the full TTL.
      updatedAt: lookupFailed && firstTs === null ? now - SYMBOL_TTL_MS + SYMBOL_RETRY_MS : now,
    };
    await this.repos.symbols.upsert(row);
    // Bars cached before the row existed, and not by this process after it saw the symbol with nothing cached.
    if (prev === null && assetClass === 'stock' && !this.freshSymbols.has(id) && (await this.repos.bars.hasAny(id))) {
      await this.purgeUntracked(id, now);
    }
    return toInfo(row, assetClass, code);
  }

  /**
   * A stock whose bars were cached before its symbols row existed (e.g. the metadata lookup failed then) was never
   * checked for splits, and when its bars were fetched is unknown. The new row starts split tracking now, so
   * everything still refetchable (daily bars, intraday bars inside the provider lookback) is dropped and fetched
   * again adjusted as of today; older intraday bars cannot be refetched and are kept as they are.
   */
  private async purgeUntracked(id: SymbolId, now: number): Promise<void> {
    const limits = this.provider('stock').limits.maxLookbackMs;
    const ops: SplitOp[] = [{ tf: '1D', cut: Number.MIN_SAFE_INTEGER }];
    for (const tf of INTRADAY_NATIVE) {
      const L = limits[tf];
      ops.push({ tf, cut: L === undefined ? Number.MIN_SAFE_INTEGER : now - L });
    }
    await this.repos.bars.applySplit(id, ops, now);
    this.epoch++;
  }

  private searchClass(cls: MarketClass, q: string): Promise<SymbolInfo[]> {
    return this.queues[cls].run(`search|${q}`, () => this.provider(cls).search(q));
  }

  private provider(cls: MarketClass): MarketDataProvider {
    return this.registry[cls];
  }
}

function toInfo(row: SymbolInfoRow, assetClass: MarketClass, code: string): SymbolInfo {
  const info: SymbolInfo = { id: row.id, assetClass, ticker: row.ticker ?? code, name: row.name, pricePrecision: row.pricePrecision };
  if (row.exchange != null) info.exchange = row.exchange;
  return info;
}

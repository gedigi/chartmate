import {
  baseTimeframe, bucketStart, filterSession, isIntraday, parseSymbolId, resample, tfMs,
  type AssetClass, type Bar, type Calendar, type NativeTimeframe, type Quote, type SessionMode,
  type SymbolId, type SymbolInfo, type Timeframe,
} from '@chartmate/shared';
import type { Repos, SplitOp, SymbolInfoRow } from '../db/repos.js';
import { AppError, NotFoundError, ProviderError } from '../errors.js';
import { RequestQueue } from '../providers/queue.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { MarketDataProvider } from '../providers/types.js';
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
/** A provider "no data" answer for a chunk ending longer ago than this is trusted (cached as empty). */
const NO_DATA_TRUST_MS = 7 * DAY;
/** Stock splits are checked at most this often per symbol. */
const SPLIT_CHECK_MS = DAY;
/** Retry delay after a failed split lookup. */
const SPLIT_RETRY_MS = 60 * 60_000;
/** Never-checked rows (pre-migration): splits older than updated_at - this are assumed reflected in the cache. */
const SPLIT_BASELINE_SLACK_MS = 7 * DAY;
const INTRADAY_NATIVE: NativeTimeframe[] = ['1m', '5m', '15m', '30m', '1h'];

export interface GetBarsArgs { symbol: SymbolId; tf: Timeframe; session: SessionMode; from: number; to: number }
export interface BarsResult { bars: Bar[]; stale: boolean; hasMoreBefore: boolean; earliestTs: number | null; notices: string[] }

type MarketClass = 'stock' | 'crypto';

export function calendarFor(symbol: SymbolId, session: SessionMode): Calendar {
  if (symbol.startsWith('crypto:')) return 'utc';
  return session === 'rth' ? 'nyse-rth' : 'nyse-eth';
}

/** Exclusive end of the `tf` bucket that contains `ts`. */
function bucketEnd(ts: number, tf: Timeframe, cal: Calendar): number {
  const start = bucketStart(ts, tf, cal);
  if (tf === '1M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + tfMs(tf);
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

  constructor(deps: { repos: Repos; registry: ProviderRegistry; now?: () => number; queues?: { stock: RequestQueue; crypto: RequestQueue } }) {
    this.repos = deps.repos;
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
        this.splitNextCheck.set(symbol, now + (cached ? SPLIT_RETRY_MS : SPLIT_CHECK_MS));
        return;
      }
      const last = row.splitsCheckedAt ?? null;
      if (last !== null && now - last < SPLIT_CHECK_MS) {
        this.splitNextCheck.set(symbol, last + SPLIT_CHECK_MS);
        return;
      }
      // Rows from before split checks existed: splits older than the row's refresh (minus slack) are already
      // reflected in what was cached.
      const since = last ?? row.updatedAt - SPLIT_BASELINE_SLACK_MS;
      const splits = await this.queues.stock.run(`splits|${code}|${since}`, () => provider.splitsSince!(code, since));
      // Only splits that already happened: a future-dated (announced) event is applied once it has occurred.
      const relevant = splits.filter((sp) => sp.ts > since && sp.ts <= now).sort((x, y) => x.ts - y.ts);
      if (relevant.length > 0) {
        await this.repos.bars.applySplit(symbol, this.splitOps(relevant), now); // stamps in the same transaction
        this.epoch++;
      } else {
        await this.repos.symbols.markSplitsChecked(symbol, now);
      }
      this.splitNextCheck.set(symbol, now + SPLIT_CHECK_MS);
    } catch (err) {
      if (err instanceof ProviderError && err.retryable && err.provider !== 'queue') this.queues.stock.backoff(BACKOFF_MS);
      this.splitNextCheck.set(symbol, now + SPLIT_RETRY_MS); // never fail a bars request over this
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
        await this.repos.bars.upsert(symbol, tf, fetched.bars);
        await markCovered(gapFrom, gapTo);
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
      if (known === false) throw firstNotFound;
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
    // 1D looks back a week so a stock's last session (Friday, before a holiday) is found over a (long) weekend.
    const back = tf === '1D' || tf === '1W' ? 7 * DAY : tf === '1M' ? 31 * DAY : tfMs(tf);
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
      } catch {
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
    return toInfo(row, assetClass, code);
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

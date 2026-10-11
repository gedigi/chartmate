import {
  parseSymbolId, TIMEFRAMES, tfMs,
  type Bar, type BarsResponse, type LatestResponse, type Quote, type SymbolId, type SymbolInfo, type Timeframe,
} from '@altv/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BasketService } from '../baskets/service.js';
import { ProviderError } from '../errors.js';
import type { MarketDataService } from '../market/service.js';
import { parse, SymbolIdSchema, symbolList } from './validation.js';

const DAY = 86_400_000;
const MAX_BARS_PER_REQUEST = 4000;
const MAX_SEARCH_RESULTS = 30;
const SPARKLINE_POINTS = 30;
const SPARKLINE_LOOKBACK_MS = 45 * DAY;
const QUOTE_LOOKBACK_MS = 10 * DAY;

export interface MarketRouteDeps { market: MarketDataService; baskets: BasketService; now?: () => number }

const TimeframeSchema = z.enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]);
const SessionSchema = z.enum(['rth', 'eth']);
const MsInt = z.string().regex(/^\d{1,15}$/, 'must be a non-negative integer (ms)').transform(Number);

const BarsQuery = z.object({ symbol: SymbolIdSchema, tf: TimeframeSchema, session: SessionSchema, from: MsInt, to: MsInt })
  .superRefine((q, ctx) => {
    if (!(q.from < q.to)) ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must be < to' });
    else if (q.to - q.from > MAX_BARS_PER_REQUEST * tfMs(q.tf)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `range exceeds ${MAX_BARS_PER_REQUEST} × ${q.tf}` });
    }
  });
const LatestQuery = z.object({ symbol: SymbolIdSchema, tf: TimeframeSchema, session: SessionSchema });
const SearchQuery = z.object({ q: z.string().trim().min(1).max(40) });
const SymbolsQuery = z.object({ symbols: symbolList(50) });
const IdParams = z.object({ id: SymbolIdSchema });

const isBasket = (id: SymbolId) => parseSymbolId(id).assetClass === 'basket';
const basketCode = (id: SymbolId) => parseSymbolId(id).code;

export async function marketRoutes(app: FastifyInstance, deps: MarketRouteDeps): Promise<void> {
  const { market, baskets } = deps;
  const now = deps.now ?? Date.now;

  const basketInfo = (b: { id: string; name: string }): SymbolInfo =>
    ({ id: `basket:${b.id}`, assetClass: 'basket', ticker: b.name, name: b.name, pricePrecision: 2 });

  /** Last ~10 daily basket bars → quote (price = last close, change vs previous close). */
  async function basketQuote(id: SymbolId): Promise<Quote | null> {
    const t = now();
    const r = await baskets.getBars({ id: basketCode(id), tf: '1D', session: 'rth', from: t - QUOTE_LOOKBACK_MS, to: t + DAY });
    const last = r.bars.at(-1);
    if (!last) return null;
    const prev = r.bars.at(-2);
    const changePct = prev && prev.close !== 0 ? ((last.close - prev.close) / prev.close) * 100 : null;
    return { id, price: last.close, changePct, ts: last.ts };
  }

  async function dailyCloses(id: SymbolId): Promise<number[]> {
    const t = now();
    const args = { tf: '1D' as const, session: 'rth' as const, from: t - SPARKLINE_LOOKBACK_MS, to: t + DAY };
    const bars: Bar[] = isBasket(id)
      ? (await baskets.getBars({ id: basketCode(id), ...args })).bars
      : (await market.getBars({ symbol: id, ...args })).bars;
    return bars.slice(-SPARKLINE_POINTS).map((b) => b.close);
  }

  app.get('/api/symbols/search', async (request): Promise<SymbolInfo[]> => {
    const { q } = parse(SearchQuery, request.query);
    const needle = q.toLowerCase();
    const basketMatches = (await baskets.list()).filter((b) => b.name.toLowerCase().includes(needle)).map(basketInfo);
    let found: SymbolInfo[];
    try {
      found = await market.search(q);
    } catch (err) {
      // Basket hits are still useful when the market search provider is down.
      if (err instanceof ProviderError && basketMatches.length > 0) found = [];
      else throw err;
    }
    return [...basketMatches, ...found].slice(0, MAX_SEARCH_RESULTS);
  });

  app.get('/api/symbols/:id', async (request): Promise<SymbolInfo> => {
    const { id } = parse(IdParams, request.params);
    if (isBasket(id)) return basketInfo(await baskets.get(basketCode(id)));
    return market.symbolInfo(id);
  });

  app.get('/api/bars', async (request): Promise<BarsResponse> => {
    const q = parse(BarsQuery, request.query);
    const head = { symbol: q.symbol, tf: q.tf, session: q.session };
    if (isBasket(q.symbol)) {
      const r = await baskets.getBars({ id: basketCode(q.symbol), tf: q.tf, session: q.session, from: q.from, to: q.to });
      return { ...head, bars: r.bars, hasMoreBefore: r.hasMoreBefore, stale: r.stale, notices: r.notices, markers: r.markers };
    }
    const r = await market.getBars(q);
    return { ...head, bars: r.bars, hasMoreBefore: r.hasMoreBefore, stale: r.stale, notices: r.notices, markers: [] };
  });

  app.get('/api/latest', async (request): Promise<LatestResponse> => {
    const q = parse(LatestQuery, request.query);
    const r = isBasket(q.symbol)
      ? await baskets.getLatest(basketCode(q.symbol), q.tf, q.session)
      : await market.getLatest(q.symbol, q.tf, q.session);
    return { bar: r.bar, stale: r.stale };
  });

  app.get('/api/quotes', async (request): Promise<Quote[]> => {
    const { symbols } = parse(SymbolsQuery, request.query);
    const basketIds = symbols.filter(isBasket);
    const [marketQuotes, basketQuotes] = await Promise.all([
      market.quotes(symbols.filter((id) => !isBasket(id))),
      Promise.allSettled(basketIds.map(basketQuote)),
    ]);
    const byId = new Map<SymbolId, Quote>(marketQuotes.map((q) => [q.id, q]));
    basketQuotes.forEach((r) => { if (r.status === 'fulfilled' && r.value) byId.set(r.value.id, r.value); });
    return symbols.flatMap((id) => byId.get(id) ?? []);
  });

  app.get('/api/sparklines', async (request): Promise<Record<SymbolId, number[]>> => {
    const { symbols } = parse(SymbolsQuery, request.query);
    const results = await Promise.allSettled(symbols.map(dailyCloses));
    const out: Record<SymbolId, number[]> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out[symbols[i]!] = r.value;
      else request.log.debug({ err: r.reason, symbol: symbols[i] }, 'sparkline omitted');
    });
    return out;
  });
}

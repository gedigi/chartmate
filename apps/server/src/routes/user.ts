import { MAX_INDICATORS, TIMEFRAMES, type DrawingState, type Layout, type SymbolId, type Timeframe } from '@altv/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repos } from '../db/repos.js';
import { NotFoundError } from '../errors.js';
import { isSymbolId, parse, SymbolIdSchema } from './validation.js';

const MAX_STYLES_BYTES = 10 * 1024;

const IndicatorSchema = z.object({
  name: z.string().max(40),
  pane: z.enum(['main', 'sub']),
  calcParams: z.array(z.number()).max(10),
  visible: z.boolean(),
  lineColors: z.array(z.string().max(32)).max(10).optional(),
});
const LayoutSchema = z.object({
  symbol: SymbolIdSchema,
  tf: z.enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  session: z.enum(['rth', 'eth']),
  chartType: z.enum(['candle', 'ohlc', 'line', 'area']),
  indicators: z.array(IndicatorSchema).max(MAX_INDICATORS),
}) satisfies z.ZodType<Layout>;

const DrawingSchema = z.object({
  name: z.string().max(40),
  points: z.array(z.object({ timestamp: z.number(), value: z.number() })).max(10),
  lock: z.boolean(),
  text: z.string().max(500).optional(),
  styles: z.unknown().optional().refine(
    (s) => s === undefined || (JSON.stringify(s)?.length ?? 0) <= MAX_STYLES_BYTES,
    { message: `styles must serialize to ≤ ${MAX_STYLES_BYTES} bytes` },
  ),
}) satisfies z.ZodType<DrawingState>;

const WatchlistBody = z.array(SymbolIdSchema).max(200);
const DrawingsBody = z.array(DrawingSchema).max(500);
const LayoutKey = z.object({
  key: z.string().max(110).refine((k) => k === 'default' || (k.startsWith('sym:') && isSymbolId(k.slice(4))), {
    message: "layout key must be 'default' or 'sym:<symbol id>'",
  }),
});
const SymbolParams = z.object({ symbol: SymbolIdSchema });

export async function userRoutes(app: FastifyInstance, deps: { repos: Repos }): Promise<void> {
  const { repos } = deps;

  app.get('/api/watchlist', async (): Promise<SymbolId[]> => repos.watchlist.list());
  app.put('/api/watchlist', async (request): Promise<SymbolId[]> => {
    const ids = [...new Set(parse(WatchlistBody, request.body))];
    await repos.watchlist.replace(ids);
    return repos.watchlist.list();
  });

  app.get('/api/layouts/:key', async (request): Promise<Layout> => {
    const { key } = parse(LayoutKey, request.params);
    const layout = await repos.layouts.get(key);
    if (!layout) throw new NotFoundError(`No layout ${key}`);
    return layout;
  });
  app.put('/api/layouts/:key', async (request): Promise<Layout> => {
    const { key } = parse(LayoutKey, request.params);
    const layout = parse(LayoutSchema, request.body);
    await repos.layouts.put(key, layout);
    return layout;
  });

  app.get('/api/drawings/:symbol', async (request): Promise<DrawingState[]> =>
    repos.drawings.get(parse(SymbolParams, request.params).symbol));
  app.put('/api/drawings/:symbol', async (request): Promise<DrawingState[]> => {
    const { symbol } = parse(SymbolParams, request.params);
    const drawings = parse(DrawingsBody, request.body);
    await repos.drawings.put(symbol, drawings);
    return drawings;
  });
}

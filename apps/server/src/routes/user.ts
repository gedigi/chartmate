import {
  HEX_COLOR_RE, MAX_INDICATORS, MAX_LINE_WIDTH, MAX_TEXT_SIZE, MIN_LINE_WIDTH, MIN_TEXT_SIZE, TIMEFRAMES,
  type DrawingState, type Layout, type SymbolId, type Timeframe,
} from '@altv/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repos } from '../db/repos.js';
import { NotFoundError } from '../errors.js';
import { isSymbolId, parse, SymbolIdSchema } from './validation.js';

const Hex = z.string().regex(HEX_COLOR_RE, 'colour must be #rrggbb');
const LineWidth = z.number().int().min(MIN_LINE_WIDTH).max(MAX_LINE_WIDTH);
const LineStyle = z.enum(['solid', 'dashed']);
const LineStyleSchema = z.object({ color: Hex, size: LineWidth, style: LineStyle });

const AppearanceSchema = z.object({
  upColor: Hex.optional(),
  downColor: Hex.optional(),
  candleBody: z.enum(['solid', 'hollow', 'hollow_up', 'hollow_down']).optional(),
  lineColor: Hex.optional(),
  lineWidth: LineWidth.optional(),
  drawing: LineStyleSchema.strict().optional(),
}).strict();

/** Normalized drawing styles; unknown keys (e.g. raw KLineChart styles) are stripped. */
const DrawingStylesSchema = z.object({
  line: LineStyleSchema.optional(),
  text: z.object({ color: Hex, size: z.number().int().min(MIN_TEXT_SIZE).max(MAX_TEXT_SIZE) }).optional(),
});

const IndicatorSchema = z.object({
  name: z.string().max(40),
  pane: z.enum(['main', 'sub']),
  calcParams: z.array(z.number()).max(10),
  visible: z.boolean(),
  lineColors: z.array(z.string().max(32)).max(10).optional(),
  lineWidths: z.array(LineWidth).max(10).optional(),
  lineStyles: z.array(LineStyle).max(10).optional(),
  barColors: z.object({ up: Hex, down: Hex }).optional(),
});
const LayoutSchema = z.object({
  symbol: SymbolIdSchema,
  tf: z.enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  session: z.enum(['rth', 'eth']),
  chartType: z.enum(['candle', 'ohlc', 'line', 'area']),
  indicators: z.array(IndicatorSchema).max(MAX_INDICATORS),
  appearance: AppearanceSchema.optional(),
}) satisfies z.ZodType<Layout>;

const DrawingSchema = z.object({
  name: z.string().max(40),
  points: z.array(z.object({ timestamp: z.number(), value: z.number() })).max(10),
  lock: z.boolean(),
  text: z.string().max(500).optional(), anchorTf: z.enum(['1D', '1W', '1M']).optional(),
  // Tolerant: invalid / legacy styles are dropped (the drawing itself is still saved).
  styles: DrawingStylesSchema.optional().catch(undefined),
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

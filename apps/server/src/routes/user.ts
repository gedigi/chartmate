import {
  HEX_COLOR_RE, MAX_CURRENCY_LENGTH, MAX_INDICATORS, MAX_LINE_WIDTH, MAX_POSITION_AMOUNT, MAX_RISK_PERCENT, MAX_SECTION_TITLE,
  MAX_TEXT_SIZE, MAX_WATCHLIST_SECTIONS, MAX_WATCHLIST_SYMBOLS, MIN_LINE_WIDTH, MIN_TEXT_SIZE, migrateAppearance, TIMEFRAMES,
  mergeLegacyWatchlist, watchlistProblem,
  type DrawingState, type Layout, type PositionSettings, type Timeframe, type WatchlistEntry,
} from '@altv/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repos } from '../db/repos.js';
import { isSymbolId, parse, SymbolIdSchema } from './validation.js';

const Hex = z.string().regex(HEX_COLOR_RE, 'colour must be #rrggbb');
const LineWidth = z.number().int().min(MIN_LINE_WIDTH).max(MAX_LINE_WIDTH);
const LineStyle = z.enum(['solid', 'dashed', 'dotted']);
const LineStyleSchema = z.object({ color: Hex, size: LineWidth, style: LineStyle });

const AppearanceSchema = z.object({
  upColor: Hex.optional(),
  downColor: Hex.optional(),
  candleBody: z.enum(['solid', 'hollow', 'hollow_up', 'hollow_down']).optional(),
  lineColor: Hex.optional(),
  lineWidth: LineWidth.optional(),
  drawing: LineStyleSchema.strict().optional(),
}).strict();

/**
 * Per-theme appearance. The legacy flat shape (one appearance for both themes, saved before appearance was per
 * theme) is still accepted and migrated to the dark theme, where it was chosen.
 */
const ThemedAppearanceSchema = z.union([
  z.object({ dark: AppearanceSchema.optional(), light: AppearanceSchema.optional() }).strict(),
  AppearanceSchema.transform((a) => ({ dark: a })),
]);

/** Money amounts of positions: positive, finite, at most MAX_POSITION_AMOUNT (same limits as the client sanitizer). */
const Amount = z.number().positive().max(MAX_POSITION_AMOUNT);
const Currency = z.string().trim().min(1).max(MAX_CURRENCY_LENGTH);
const RiskMode = z.enum(['percent', 'amount']);
/** A position's own risk settings (each field optional; unknown keys rejected). */
const percentOk = (d: { riskMode?: string; riskValue?: number }) => d.riskMode !== 'percent' || d.riskValue === undefined || d.riskValue <= MAX_RISK_PERCENT;
const PositionSettingsSchema = z.object({
  accountSize: Amount.optional(), riskMode: RiskMode.optional(), riskValue: Amount.optional(), currency: Currency.optional(),
}).strict().refine(percentOk, { message: 'risk percentage must be at most 100' });
/** Global defaults of new positions: every field required; a percentage risk is at most 100 %. */
const PositionDefaultsSchema = z.object({ accountSize: Amount, riskMode: RiskMode, riskValue: Amount, currency: Currency })
  .strict()
  .refine(percentOk, { message: 'risk percentage must be at most 100' });

/**
 * Normalized drawing styles; unknown keys (e.g. raw KLineChart styles) are stripped. Tolerant per part: an invalid
 * `line`, `text`, `label`, `extend` or `position` part is dropped on its own so valid parts survive; if no valid part remains, styles are dropped.
 */
const DrawingStylesSchema = z.object({
  line: LineStyleSchema.optional().catch(undefined),
  text: z.object({ color: Hex, size: z.number().int().min(MIN_TEXT_SIZE).max(MAX_TEXT_SIZE) }).optional().catch(undefined),
  label: z.object({ onLine: z.boolean().optional(), onAxis: z.boolean().optional() }).optional().catch(undefined),
  extend: z.object({ left: z.boolean().optional(), right: z.boolean().optional() }).optional().catch(undefined),
  position: PositionSettingsSchema.optional().catch(undefined),
}).transform((s) => {
  const out: {
    line?: z.infer<typeof LineStyleSchema>; text?: { color: string; size: number }; label?: { onLine?: boolean; onAxis?: boolean };
    extend?: { left?: boolean; right?: boolean }; position?: PositionSettings;
  } = {};
  if (s.line) out.line = s.line;
  if (s.text) out.text = s.text;
  if (s.label && (s.label.onLine !== undefined || s.label.onAxis !== undefined)) out.label = s.label;
  if (s.extend && (s.extend.left !== undefined || s.extend.right !== undefined)) out.extend = s.extend;
  if (s.position && Object.keys(s.position).length > 0) out.position = s.position as PositionSettings;
  return out.line || out.text || out.label || out.extend || out.position ? out : undefined;
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
  appearance: ThemedAppearanceSchema.optional(),
  // Tolerant: invalid defaults are dropped on their own, so they can never block saving the rest of the layout.
  positionDefaults: PositionDefaultsSchema.optional().catch(undefined),
}) satisfies z.ZodType<Layout, unknown>;

const DrawingSchema = z.object({
  name: z.string().max(40),
  points: z.array(z.object({ timestamp: z.number(), value: z.number() })).max(10),
  lock: z.boolean(),
  text: z.string().max(500).optional(), anchorTf: z.enum(['1D', '1W', '1M']).optional(),
  // Tolerant: invalid / legacy styles are dropped (the drawing itself is still saved).
  styles: DrawingStylesSchema.optional().catch(undefined),
}) satisfies z.ZodType<DrawingState>;

const WatchlistEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('symbol'), id: SymbolIdSchema }).strict(),
  z.object({
    type: z.literal('section'),
    id: z.uuid(),
    title: z.string().max(MAX_SECTION_TITLE).refine((t) => t.trim().length > 0, { message: 'section title must not be empty' }),
    collapsed: z.boolean(),
  }).strict(),
]);
/**
 * The watchlist: an entry array (symbols and section headers), or the legacy symbol id array (duplicates dropped),
 * which is merged into the stored list so its sections survive (see `mergeLegacyWatchlist`).
 */
const WatchlistBody = z.union([
  z.array(SymbolIdSchema).max(MAX_WATCHLIST_SYMBOLS).transform((ids) => ({ legacy: ids })),
  z.array(WatchlistEntrySchema).max(MAX_WATCHLIST_SYMBOLS + MAX_WATCHLIST_SECTIONS).superRefine((entries, ctx) => {
    const problem = watchlistProblem(entries);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }).transform((entries) => ({ entries })),
]);
const DrawingsBody = z.array(DrawingSchema).max(500);
const LayoutKey = z.object({
  key: z.string().max(110).refine((k) => k === 'default' || (k.startsWith('sym:') && isSymbolId(k.slice(4))), {
    message: "layout key must be 'default' or 'sym:<symbol id>'",
  }),
});
const SymbolParams = z.object({ symbol: SymbolIdSchema });

export async function userRoutes(app: FastifyInstance, deps: { repos: Repos }): Promise<void> {
  const { repos } = deps;

  app.get('/api/watchlist', async (): Promise<WatchlistEntry[]> => repos.watchlist.list());
  app.put('/api/watchlist', async (request): Promise<WatchlistEntry[]> => {
    const body = parse(WatchlistBody, request.body);
    // A tab opened before sections existed sends symbol ids only: merge them so the stored sections survive.
    const entries = 'legacy' in body ? mergeLegacyWatchlist(await repos.watchlist.list(), body.legacy) : body.entries;
    await repos.watchlist.replace(entries);
    return repos.watchlist.list();
  });

  // A missing (valid) key is 200 with a JSON `null` body, so first visits produce no 404 noise.
  app.get('/api/layouts/:key', async (request, reply): Promise<Layout | null> => {
    const { key } = parse(LayoutKey, request.params);
    const layout = await repos.layouts.get(key);
    if (!layout) return reply.type('application/json; charset=utf-8').send('null');
    if (layout.appearance === undefined) return layout;
    // Rows saved before appearance was per theme hold the flat shape.
    const { appearance, ...rest } = layout;
    const themed = migrateAppearance(appearance);
    return themed ? { ...rest, appearance: themed } : rest;
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

import {
  CORPORATE_EVENT_KINDS, DRAWING_COLOR_RE, DRAWING_COLOR_TOKENS, HEX_COLOR_RE, MAX_INDICATOR_LEVEL, MAX_INDICATOR_LEVELS, MAX_INDICATORS, MAX_LINE_WIDTH, MAX_POSITION_PCT, MAX_SECTION_TITLE,
  MAX_TEXT_SIZE, MAX_WATCHLIST_SECTIONS, MAX_WATCHLIST_SYMBOLS, MIN_LINE_WIDTH, MIN_TEXT_SIZE, migrateAppearance, TIMEFRAMES,
  mergeLegacyWatchlist, normalizeSymbolId, tryNormalizeSymbolId, WATCHLIST_STORED_HEADER, watchlistProblem,
  type DrawingDefaults, type DrawingState, type Layout, type Timeframe, type WatchlistEntry,
} from '@chartmate/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FALLBACK_LAYOUT_SYMBOL } from '../db/migrations.js';
import type { Repos } from '../db/repos.js';
import { isSymbolId, parse, SymbolIdSchema } from './validation.js';

const Hex = z.string().regex(HEX_COLOR_RE, 'color must be #rrggbb');
const LineWidth = z.number().int().min(MIN_LINE_WIDTH).max(MAX_LINE_WIDTH);
const LineStyle = z.enum(['solid', 'dashed', 'dotted']);
const LineStyleSchema = z.object({ color: Hex, size: LineWidth, style: LineStyle });
/**
 * A drawing's own color: '#rrggbb' (every drawing saved before palette references) or a theme palette reference
 * ('accent', 'text', 'muted', 'up', 'down', 'palette:0'…'palette:5') the web app resolves per theme.
 */
const DrawingColor = z.string().regex(DRAWING_COLOR_RE, 'color must be #rrggbb or a palette reference');
const DrawingLineStyleSchema = z.object({ color: DrawingColor, size: LineWidth, style: LineStyle });

const AppearanceSchema = z.object({
  upColor: Hex.optional(),
  downColor: Hex.optional(),
  candleBody: z.enum(['solid', 'hollow', 'hollow_up', 'hollow_down']).optional(),
  lineColor: Hex.optional(),
  lineWidth: LineWidth.optional(),
  drawing: LineStyleSchema.strict().optional(),
  lastPriceLine: z.enum(['neutral', 'candle']).optional(),
}).strict();

/**
 * Per-theme appearance. The legacy flat shape (one appearance for both themes, saved before appearance was per
 * theme) is still accepted and migrated to the dark theme, where it was chosen.
 */
const ThemedAppearanceSchema = z.union([
  z.object({ dark: AppearanceSchema.optional(), light: AppearanceSchema.optional() }).strict(),
  AppearanceSchema.transform((a) => ({ dark: a })),
]);

/**
 * Global defaults of new positions: target / stop distance in % of the entry (same limits as the client). Other keys
 * are stripped, e.g. the account / risk / currency of positions saved when they were sized.
 */
const Pct = z.number().positive().max(MAX_POSITION_PCT);
const PositionDefaultsSchema = z.object({ targetPct: Pct, stopPct: Pct });

/**
 * Normalized drawing styles; unknown keys (e.g. raw KLineChart styles, or the `position` sizing settings of positions
 * saved when they were sized) are stripped. Tolerant per part: an invalid `line`, `text`, `label`, `extend` or `fill` part is
 * dropped on its own so valid parts survive; if no valid part remains, styles are dropped.
 */
const DrawingStylesSchema = z.object({
  line: DrawingLineStyleSchema.optional().catch(undefined),
  // A color of its own without a line style: width and dash follow the default drawing style.
  color: DrawingColor.optional().catch(undefined),
  text: z.object({ color: DrawingColor, size: z.number().int().min(MIN_TEXT_SIZE).max(MAX_TEXT_SIZE) }).optional().catch(undefined),
  label: z.object({ onLine: z.boolean().optional(), onAxis: z.boolean().optional() }).optional().catch(undefined),
  extend: z.object({ left: z.boolean().optional(), right: z.boolean().optional() }).optional().catch(undefined),
  // Rectangles: the tint inside (missing → filled).
  fill: z.boolean().optional().catch(undefined),
}).transform((s) => {
  const out: {
    line?: z.infer<typeof DrawingLineStyleSchema>; color?: string; text?: { color: string; size: number }; label?: { onLine?: boolean; onAxis?: boolean };
    extend?: { left?: boolean; right?: boolean };
    fill?: boolean;
  } = {};
  if (s.line) out.line = s.line;
  if (s.color) out.color = s.color;
  if (s.text) out.text = s.text;
  if (s.label && (s.label.onLine !== undefined || s.label.onAxis !== undefined)) out.label = s.label;
  if (s.extend && (s.extend.left !== undefined || s.extend.right !== undefined)) out.extend = s.extend;
  if (s.fill !== undefined) out.fill = s.fill;
  return out.line || out.color || out.text || out.label || out.extend || out.fill !== undefined ? out : undefined;
});

const IndicatorSchema = z.object({
  name: z.string().max(40),
  pane: z.enum(['main', 'sub']),
  calcParams: z.array(z.number()).max(10),
  visible: z.boolean(),
  lineColors: z.array(z.string().max(32)).max(10).optional(),
  lineWidths: z.array(LineWidth).max(10).optional(),
  lineStyles: z.array(LineStyle).max(10).optional(),
  barColors: z.object({ up: DrawingColor, down: DrawingColor }).optional(),
  levels: z.array(z.number().finite().min(-MAX_INDICATOR_LEVEL).max(MAX_INDICATOR_LEVEL)).max(MAX_INDICATOR_LEVELS).optional(),
  showLevels: z.boolean().optional(),
});
const LabelToggles = z.object({ onLine: z.boolean(), onAxis: z.boolean() });
const DrawingDefaultsSchema = z.object({
  size: LineWidth.optional().catch(undefined),
  style: LineStyle.optional().catch(undefined),
  textSize: z.number().int().min(MIN_TEXT_SIZE).max(MAX_TEXT_SIZE).optional().catch(undefined),
  fill: z.boolean().optional().catch(undefined),
  extend: z.object({ left: z.boolean(), right: z.boolean() }).optional().catch(undefined),
  labels: z.object({
    priceLine: LabelToggles.optional().catch(undefined),
    horizontalStraightLine: LabelToggles.optional().catch(undefined),
  }).optional().catch(undefined),
}) satisfies z.ZodType<DrawingDefaults, unknown>;
const LayoutSchema = z.object({
  symbol: SymbolIdSchema,
  tf: z.enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
  session: z.enum(['rth', 'eth']),
  chartType: z.enum(['candle', 'ohlc', 'line', 'area']),
  indicators: z.array(IndicatorSchema).max(MAX_INDICATORS),
  appearance: ThemedAppearanceSchema.optional(),
  // Tolerant: invalid defaults are dropped on their own, so they can never block saving the rest of the layout.
  positionDefaults: PositionDefaultsSchema.optional().catch(undefined),
  colorDefaultsRev: z.number().int().min(0).max(1_000_000).optional(),
  // Color of new drawings: the last swatch picked, so a palette reference only (no layout ever stored a hex here).
  // Tolerant: an invalid value is dropped on its own.
  drawingColor: z.enum(DRAWING_COLOR_TOKENS).optional().catch(undefined),
  // Style of new drawings (the last one set in a style bar). Tolerant: each invalid part is dropped on its own.
  drawingDefaults: DrawingDefaultsSchema.optional().catch(undefined),
  // Event kinds hidden on stock charts. Tolerant: an invalid list is dropped on its own (all kinds shown again).
  hiddenEvents: z.array(z.enum(CORPORATE_EVENT_KINDS)).max(CORPORATE_EVENT_KINDS.length).optional().catch(undefined),
}) satisfies z.ZodType<Layout, unknown>;

const DrawingSchema = z.object({
  name: z.string().max(40),
  points: z.array(z.object({ timestamp: z.number(), value: z.number() })).min(1).max(10),
  lock: z.boolean(),
  // The drawing's own lock (optional: older drawings have none). Tolerant: an invalid flag is dropped on its own.
  locked: z.boolean().optional().catch(undefined),
  text: z.string().max(500).optional(), anchorTf: z.enum(['1D', '1W', '1M']).optional(),
  // Tolerant: invalid / legacy styles are dropped (the drawing itself is still saved).
  styles: DrawingStylesSchema.optional().catch(undefined),
}).superRefine((d, ctx) => {
  // A rectangle is its two opposite corners (the web app derives its other handles from them).
  if (d.name === 'rectangle' && (d.points.length !== 2 || !d.points.every((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)))) {
    ctx.addIssue({ code: 'custom', path: ['points'], message: 'a rectangle has exactly two finite corners' });
  }
}).transform((d) => {
  // The fill option belongs to rectangles: dropped from any other drawing (with its styles if nothing else is left).
  if (d.name === 'rectangle' || d.styles?.fill === undefined) return d;
  const { fill: _fill, ...styles } = d.styles;
  const { styles: _styles, ...rest } = d;
  return Object.keys(styles).length > 0 ? { ...rest, styles } : rest;
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
// A drawing without points (never drawable; older clients could store one) is dropped on its own, not the whole list.
const DrawingsBody = z.array(z.unknown()).max(500).transform((ds) => ds.filter((d) => { const points = (d as { points?: unknown } | null)?.points; return !(Array.isArray(points) && points.length === 0); })).pipe(z.array(DrawingSchema));
const LayoutKey = z.object({
  key: z.string().max(110).refine((k) => k === 'default' || (k.startsWith('sym:') && isSymbolId(k.slice(4))), {
    message: "layout key must be 'default' or 'sym:<symbol id>'",
  }).transform((k) => (k === 'default' ? k : `sym:${normalizeSymbolId(k.slice(4))}`)),
});
const SymbolParams = z.object({ symbol: SymbolIdSchema });

export async function userRoutes(app: FastifyInstance, deps: { repos: Repos }): Promise<void> {
  const { repos } = deps;

  // The body stays the plain entry array older clients read; `chartmate-watchlist-stored: 1|0` tells a new client
  // whether a list was ever saved, so it seeds its defaults only into a fresh database, never over an emptied list.
  app.get('/api/watchlist', async (_request, reply): Promise<WatchlistEntry[]> => {
    const [list, stored] = await Promise.all([repos.watchlist.list(), repos.watchlist.stored()]);
    reply.header(WATCHLIST_STORED_HEADER, stored ? '1' : '0');
    return list;
  });
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
    // Rows written before symbol ids were normalized (and missed by migration 004, e.g. by a rolled-back server).
    const symbol = tryNormalizeSymbolId(layout.symbol) ?? FALLBACK_LAYOUT_SYMBOL;
    if (symbol !== layout.symbol) layout.symbol = symbol;
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

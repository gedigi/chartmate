import {
  dispose, init,
  type Chart, type DeepPartial, type IndicatorCreate, type IndicatorDrawCallback, type IndicatorStyle, type KLineData, type Overlay, type OverlayCreate,
  type Coordinate, type OverlayMode, type OverlayStyle, type Point as KPoint, type Styles,
} from 'klinecharts';
import {
  isDrawingColorToken, isIntraday, isPositionTool, nyToUtc, resolvePositionDefaults, tfMs,
  type ChartType, type CorporateEvent, type DrawingDefaults, type CorporateEventKind, type DrawingLineStyle, type DrawingState, type IndicatorState, type Marker, type PositionDefaults,
  type ThemedAppearance, type SessionMode, type SymbolInfo, type Timeframe,
} from '@chartmate/shared';
import {
  COLOR_ONLY_KEY, COLOR_REF_KEY, colorToOverlay, klineLine, lineToOverlay, normalizeOverlayStyles, readLine, readOwnColor, readText, sanitizeDrawingStyles, textToOverlay, toOverlayStyles, TEXT_TOOL,
  type TextStyle,
} from './drawingStyles';
import {
  drawingConstraint, drawingContext, EXTEND_DEFAULTS, EXTEND_STYLE_KEY, extendOptions, FILL_DEFAULTS, FILL_STYLE_KEY, fillOption, flattenBase, LABEL_STYLE_KEY, labelOptions, registerDrawingTemplates, roundPrice, SHIFT_TOOLS,
  type ExtendOptions, type LabelOptions,
} from './drawingTemplates';
import {
  barIndex, barTime, DEFAULT_WIDTH_BARS, defaultGeometry, endAfterBars, fromPositionPoints, nextBarTime, shiftByBars, sideOf,
  toPositionPoints, validatePrices, type OutcomeBar, type PositionMetrics, type PositionOutcome, type PositionSide,
} from './position';
import { positionContext, positionState, registerPositionOverlays, releasePositionContext } from './positionOverlay';
import { isDegenerateBox, persistedPoints, RECTANGLE, registerRectangleOverlay } from './rectangle';
import { drawingClipboard, type DrawingClip } from './drawingClipboard';
import { DEFAULT_DRAWING_COLOR, drawingSwatches, resolveDrawingColor, type DrawingSwatch } from './drawingColors';
import { createDataLoader, type DataLoaderImpl, type LoaderEvents } from './dataLoader';
import { catalogEntry, defaultLineColor, effectiveLevels, lineColorOverride } from './indicators/catalog';
import { indicatorColorContext } from './indicators/colors';
import { CUSTOM_INDICATORS, PRICE_PRECISION_INDICATORS } from './indicators/extensions';
import { levelsDraw, levelsRange } from './indicators/levels';
import { registerCustomIndicators } from './indicators/register';
import type { IndicatorExtendData } from './indicators/types';
import { toPeriod } from './periods';
import { barsShown, fitBarSpace, rangeLabel, rangeLookbackMs, rangeStart, visibleBarCount, type RangeCalendar, type RangePreset } from './ranges';
import { MARKER_OVERLAY, markerStyles, registerMarkerOverlay } from './markers';
import { badgeStackHeight, EVENT_OVERLAY, eventGroups, groupBadges, registerEventOverlay, type EventGroup, type EventOverlayData } from './events';
import {
  MEASURE_OVERLAY, measureColors, measureLines, measureStats, registerMeasureOverlay, snapValue,
  type MeasurePoint, type MeasureSnap, type MeasureStats, type MeasureView,
} from './measure';
import { registerSessionShade, SESSION_SHADE, SHADE_INDICATORS } from './sessionShade';
import { textColoredLegends } from './barLegends';
import { solidBarFigures } from './solidBars';
import { calendarTicks, countdownText, crosshairDate, hasCountdown, tickLabelFits } from './timeLabels';
import { textWidth } from './axisRange';
import {
  candleStyles, CHART_FONT, chartStyles, DEFAULT_TEXT_SIZE, defaultIndicatorBars, defaultIndicatorCircles, effectiveBarColors, indicatorLevelColor, overlayStyles, refreshThemeTokens, resolveAppearance, resolvePaletteColor, themeSoftTone, themeTokens,
  type ThemeName,
} from './theme';

export type DrawingTool =
  | 'segment' | 'rayLine' | 'straightLine' | 'horizontalStraightLine' | 'verticalStraightLine'
  | 'priceLine' | 'parallelChannel' | 'rectangle' | 'fibonacciLine' | 'simpleAnnotation' | 'longPosition' | 'shortPosition';

export interface IndicatorSpec extends Pick<IndicatorState, 'lineColors' | 'lineWidths' | 'lineStyles' | 'barColors' | 'levels' | 'showLevels'> {
  name: string; pane: 'main' | 'sub'; calcParams?: number[]; visible?: boolean;
}

/** Style overrides of an indicator (the IndicatorSpec fields the settings dialog edits). */
type IndicatorOverrides = Pick<IndicatorSpec, 'lineColors' | 'lineWidths' | 'lineStyles' | 'barColors' | 'levels' | 'showLevels'>;
const OVERRIDE_KEYS = ['lineColors', 'lineWidths', 'lineStyles', 'barColors', 'levels', 'showLevels'] as const;
const hasOverrides = (o: IndicatorOverrides) => OVERRIDE_KEYS.some((k) => o[k] !== undefined);

/**
 * Drawings that lie at a single price (every point has the same value): the style bar edits that price.
 * Only those the toolbar offers matter, the others are listed for drawings restored from elsewhere.
 */
export const HORIZONTAL_DRAWINGS: ReadonlySet<string> = new Set(['horizontalStraightLine', 'priceLine', 'horizontalRayLine', 'horizontalSegment']);

/** Most older-data pages requested per load so positions starting before the loaded bars can be evaluated. */
export const MAX_HISTORY_PAGES = 40;

/** Most decimals a typed price keeps (crypto quotes can be finer than the symbol precision). */
export const MAX_PRICE_DECIMALS = 8;

/** A pasted drawing that would cover an identical one is moved this many bars to the right (repeated as needed). */
export const PASTE_OFFSET_BARS = 5;
/** Bars left between a pasted long / short position and the identical one it moves past (by its own width). */
export const PASTE_POSITION_GAP_BARS = 2;
/** Most steps a paste moves to get clear of identical drawings (then it lands where it got to). */
export const PASTE_CASCADE_MAX = 50;
/** A pasted horizontal line that would cover an identical one is moved up by this share of the visible price range. */
export const PASTE_OFFSET_PRICE_SHARE = 0.05;

/**
 * Lock state of the selected drawing: `locked` is the effective lock ("Lock all drawings" or its own lock: read-only,
 * not removable), `ownLock` its own lock (the style bar's lock toggle), which outlives "Lock all" being turned off.
 */
interface SelectedLock { locked: boolean; ownLock: boolean }

/** Style of the selected drawing, as the floating style bar edits it. */
export type SelectedDrawing = SelectedLock & (
  | {
    id: string; kind: 'line'; style: DrawingLineStyle;
    /** The drawing tool (overlay name), e.g. 'priceLine': price-label choices are remembered per tool. */
    name: string;
    /** Horizontal drawings only: their price and the symbol's price precision. */
    price?: { value: number; precision: number };
    /** Price / horizontal lines only: effective price-label options (price text on the line, label on the axis). */
    label?: LabelOptions;
    /** Parallel channels only: effective extend options (lines extended past the left / right end). */
    extend?: ExtendOptions;
    /** Rectangles only: whether the inside is tinted. */
    fill?: boolean;
  }
  | { id: string; kind: 'text'; style: TextStyle }
  | {
    id: string; kind: 'position'; side: PositionSide;
    entry: number; target: number; stop: number; precision: number;
    /** The derived numbers (R:R, % distances) and the outcome so far. */
    metrics: PositionMetrics; outcome: PositionOutcome;
  });

const INDICATOR_DASH = [4, 4];

/** A date range as fitted on the chart: its first and latest bar times, how many bars, and its span as text. */
/** Corporate event badges under the mouse: their events and where the top of their stack is (px, in the chart element). */
export interface EventHover { events: CorporateEvent[]; x: number; y: number }

export interface ShownRange { preset: RangePreset; first: number; last: number; bars: number; label: string }

export interface LoadParams {
  symbol: SymbolInfo; tf: Timeframe; session: SessionMode; pollMs: number;
  /** A basket with crypto constituents: its bars follow the UTC grid, so daily anchors are not remapped. */
  basketHasCrypto?: boolean;
}

const CANDLE_PANE = 'candle_pane';
/**
 * Phone width: the candle legend wraps onto a second line there (title, then two legend lines, about 65px with the
 * high-price mark under them), so the bars start lower. KLineChart widens the price range by this many pixels' worth
 * before adding the bottom gap, which leaves the highest bar about 80px down on a phone's candle pane. Wider,
 * KLineChart's default 20 % of the pane.
 */
export const COMPACT_CANDLE_TOP_GAP_PX = 120;
const DEFAULT_CANDLE_GAP = { top: 0.2, bottom: 0.1 };
/** Gap (px) after the latest bar when a date range is shown: KLineChart's default right offset. */
const RANGE_RIGHT_MARGIN_PX = 80;
/** KLineChart's double-click window and distance (Delay.ResetClick, ManhattanDistance.DoubleClick). */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 5;
const MARKERS = 'markers';
/** Overlay group of the corporate event badges (never user drawings). */
const EVENTS = 'events';
/** Group of the Shift measure overlay (never a user drawing). */
const MEASURE = 'measure';
/** A press that moves less than this (px, Manhattan) before its release is a click: the measure then follows the mouse. */
const MEASURE_CLICK_PX = 4;

/** Where a measurement is: being dragged, following the mouse after a Shift-click, or finished (shown until cleared). */
export type MeasurePhase = 'dragging' | 'placing' | 'done';
/** The Shift measure: its two ends, its numbers and its label lines. */
export interface Measurement { phase: MeasurePhase; start: MeasurePoint; end: MeasurePoint; stats: MeasureStats; lines: string[] }
/** Bar time of an outcome label: the date (daily+), else date and time in the chart timezone. */
function barTimeFormat(tf: Timeframe, timezone: string): (ts: number) => string {
  if (!isIntraday(tf)) return (ts) => new Date(ts).toISOString().slice(0, 10);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (ts) => f.format(new Date(ts)).replace(',', '');
}

/** Chart timezone: exchange time for intraday stock/basket charts, UTC otherwise (daily+ bars are UTC dates). */
function timezoneFor(symbol: SymbolInfo, tf: Timeframe): string {
  return isIntraday(tf) && symbol.assetClass !== 'crypto' ? 'America/New_York' : 'UTC';
}


function completePoints(o: Overlay): Array<{ timestamp: number; value: number }> | null {
  const pts: Array<{ timestamp: number; value: number }> = [];
  for (const p of o.points) {
    if (typeof p.timestamp !== 'number' || typeof p.value !== 'number') return null;
    pts.push({ timestamp: p.timestamp, value: p.value });
  }
  return pts.length > 0 ? persistedPoints(o.name, pts) : null;
}

/** A drawing as saved: legacy / invalid styles (e.g. raw KLineChart template styles) are dropped. */
function sanitizeDrawing(d: DrawingState): DrawingState {
  const { styles, ...rest } = d;
  const clean = sanitizeDrawingStyles(styles);
  return clean ? { ...rest, styles: clean } : rest;
}

type Point = { timestamp: number; value: number };
type AnchorTf = NonNullable<DrawingState['anchorTf']>;

/** Daily-or-longer timeframes, whose bars are stamped at UTC midnight of their date. */
function anchorTfOf(tf: Timeframe): AnchorTf | null {
  return tf === '1D' || tf === '1W' || tf === '1M' ? tf : null;
}

/** A daily bar time (UTC midnight of a date) → that date's 09:30 New York session open. */
function toSessionOpen(ts: number): number {
  const d = new Date(ts);
  return nyToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30);
}

/** Undo steps kept (per restored set of drawings). */
const MAX_UNDO = 100;

const samePoints = (a: Point[], b: Point[]) =>
  a.length === b.length && a.every((p, i) => p.timestamp === b[i]!.timestamp && p.value === b[i]!.value);

/** First index whose timestamp is ≥ ts (data sorted ascending). */
function lowerBound(data: KLineData[], ts: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid]!.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Oscillators in price units (their axis and legend read like prices). */
const PRICE_UNIT_INDICATORS: ReadonlySet<string> = new Set(['MACD', 'AO', 'MTM']);
/** Bounded oscillators (0–100 and the like): two decimals, never KLineChart's default four. */
const BOUNDED_INDICATORS: ReadonlySet<string> = new Set(['RSI', 'KDJ', 'WR', 'CCI', 'DMI']);
const FIXED_PRECISION = 2;

/** Value precision of indicator `name` (undefined = KLineChart's own). */
function indicatorPrecision(name: string, pricePrecision: number): number | undefined {
  if (PRICE_PRECISION_INDICATORS.has(name) || PRICE_UNIT_INDICATORS.has(name)) return pricePrecision;
  if (BOUNDED_INDICATORS.has(name)) return FIXED_PRECISION;
  return undefined;
}

/**
 * The only bridge between the app and KLineChart. Everything else in the app talks to this class.
 */
export class ChartAdapter {
  private readonly el: HTMLElement;
  private readonly chart: Chart;
  private theme: ThemeName;
  private compact = false;
  private chartType: ChartType = 'candle';
  private tf: Timeframe | null = null;
  private loader: DataLoaderImpl | null = null;
  private markers: Marker[] = [];
  /** Corporate events of the charted stock and the kinds hidden (see setEvents). */
  private events: CorporateEvent[] = [];
  private hiddenEvents: CorporateEventKind[] = [];
  /** The event groups drawn (re-rendered only when they change), and their overlays' ids. */
  private eventsKey = '';
  private eventGroupsShown: EventGroup[] = [];
  private readonly eventOverlayGroups = new Map<string, EventGroup>();
  private readonly eventHoverListeners = new Set<(h: EventHover | null) => void>();
  private readonly eventsShownListeners = new Set<(groups: EventGroup[]) => void>();
  private assetClass: SymbolInfo['assetClass'] | null = null;
  private basketHasCrypto = false;
  /** Passed to every indicator as `extendData` (VWAP picks its session day from it). */
  private indicatorExt: IndicatorExtendData = {};
  private readonly overrides = new Map<string, IndicatorOverrides>();
  /**
   * Indicators whose bar-color override was removed: their default bars were written explicitly (KLineChart
   * merges indicator styles, so an override cannot be unset), so a theme toggle must rewrite them.
   */
  private readonly themedBars = new Set<string>();
  /** Reference levels currently drawn per indicator id (indicators whose catalog entry defines levels). */
  private readonly drawnLevels = new Map<string, string>();
  private appearance: ThemedAppearance | undefined;
  private readonly changeListeners = new Set<() => void>();
  private silent = 0;
  private destroyed = false;
  /** The position placement helper this adapter installs (released on destroy). */
  private readonly ownEndFor = (start: number): number => this.positionEnd(start);

  constructor(el: HTMLElement, opts: { theme: ThemeName }) {
    registerSessionShade();
    registerMarkerOverlay();
    registerEventOverlay();
    registerDrawingTemplates();
    registerRectangleOverlay();
    registerPositionOverlays();
    registerMeasureOverlay();
    registerCustomIndicators();
    this.el = el;
    this.theme = opts.theme;
    refreshThemeTokens(opts.theme); // chart colors come from the CSS tokens (constants as fallback)
    this.updatePositionColors();
    this.updateIndicatorColors();
    positionContext.defaults = resolvePositionDefaults(undefined);
    positionContext.endFor = this.ownEndFor;
    positionContext.minEnd = (start) => nextBarTime(this.chart.getDataList(), start, positionContext.barMs);
    positionContext.shiftEnd = (end, from, to) => shiftByBars(this.chart.getDataList(), end, from, to, positionContext.barMs);
    positionContext.historyComplete = () => !this.hasOlderData();
    const chart = init(el, { styles: this.styles() });
    if (!chart) throw new Error('Failed to initialize the chart');
    this.chart = chart;
    // Capture phase on the host: runs before KLineChart's own mousedown handler on its inner container.
    el.addEventListener('mousedown', this.onPressCapture, true);
    chart.subscribeAction?.('onZoom', this.onUserView);
    chart.subscribeAction?.('onScroll', this.onUserView);
  }

  private styles(): DeepPartial<Styles> {
    const base = chartStyles(this.theme, { compact: this.compact });
    const countdown = this.tf !== null && this.assetClass !== null && hasCountdown(this.tf, this.assetClass);
    const candle = candleStyles(this.chartType, this.theme, this.appearance, countdown);
    return {
      ...base,
      candle: { ...base.candle, ...candle, priceMark: { ...base.candle?.priceMark, ...candle.priceMark } },
      // Default histogram bars and SAR dots follow the resolved candle colors (custom ones included).
      indicator: {
        ...base.indicator,
        bars: [{ style: 'fill', borderSize: 0, ...defaultIndicatorBars(this.theme, this.appearance) }],
        circles: [defaultIndicatorCircles(this.theme, this.appearance)],
        ohlc: defaultIndicatorBars(this.theme, this.appearance),
      },
      // Unstyled drawings follow the appearance's default drawing style (theme accent when unset).
      overlay: overlayStyles(this.defaultDrawing()),
    };
  }

  private defaultDrawing(): DrawingLineStyle {
    return resolveAppearance(this.theme, this.appearance).drawing;
  }

  /**
   * The default drawing style as a drawing would store it: the appearance's own color when set, else the accent as a
   * palette reference (so the picker marks the accent swatch, and it follows the theme). An appearance hex equal to a
   * swatch of the active theme (the appearance dialog saves the shown accent next to an edited width) is that swatch's
   * reference; any other hex stays a custom color.
   */
  private storedDefaultDrawing(): DrawingLineStyle {
    const d = this.defaultDrawing();
    if (!this.appearance?.[this.theme]?.drawing) return { ...d, color: DEFAULT_DRAWING_COLOR };
    const swatch = this.drawingSwatches().find((s) => s.color === d.color.toLowerCase());
    return swatch ? { ...d, color: swatch.token } : d;
  }

  /** Drawing color (palette reference or hex) → the color drawn in the active theme. */
  private readonly resolveColor = (c: string): string => resolveDrawingColor(c, this.theme, this.appearance);

  /** The drawing color picker's swatches in the active theme (the up / down ones follow the candle colors). */
  drawingSwatches(): DrawingSwatch[] {
    return drawingSwatches(this.theme, this.appearance);
  }

  /**
   * Redraws the drawings colored by a palette reference in the active theme's colors (theme or appearance change).
   * Not an edit: nothing is saved (what is saved, the reference, did not change).
   */
  private refreshColorRefs(): void {
    for (const o of this.userOverlays()) {
      if (!isDrawingColorToken((o.styles as Record<string, unknown> | null)?.[COLOR_REF_KEY])) continue;
      const own = !readLine(o.styles) && !readText(o.styles) ? readOwnColor(o.styles) : undefined;
      if (own) {
        this.chart.overrideOverlay({ id: o.id, styles: colorToOverlay(own, this.resolveColor) });
        continue;
      }
      const text = o.name === TEXT_TOOL ? readText(o.styles) : null;
      const line = text ? null : readLine(o.styles);
      const styles = text ? textToOverlay(text, this.resolveColor) : line ? lineToOverlay(line, this.resolveColor) : null;
      if (styles) this.chart.overrideOverlay({ id: o.id, styles });
    }
  }

  /** Indicators that paint themselves (Wyckoff) read the theme and appearance at draw time from this context. */
  private updateIndicatorColors(): void {
    indicatorColorContext.theme = this.theme;
    indicatorColorContext.appearance = this.appearance;
  }

  /**
   * Position zones / labels: the candle up / down colors of the active theme, muted gray for neutral parts. Also the
   * drawing templates' theme context (channel fills are tinted onto the chart background).
   */
  private updatePositionColors(): void {
    const a = resolveAppearance(this.theme, this.appearance);
    const t = themeTokens(this.theme);
    positionContext.colors = { up: a.upColor, down: a.downColor, neutral: t.muted, bg: t.bg };
    drawingContext.theme = this.theme;
    drawingContext.bg = t.bg;
    drawingContext.accent = t.accent;
  }

  // ── data ──────────────────────────────────────────────────────────────────

  load(p: LoadParams, events: LoaderEvents): void {
    const prevSymbol = this.loadSymbol;
    const prevMapping = this.mapsDailyAnchors();
    this.loader?.dispose(); // its pending results and polling become no-ops while the chart resets below
    this.clearMeasure();
    this.dataSymbol = null;
    this.loadSymbol = p.symbol.id;
    this.range = null; // a range shown with showRange belongs to the data it was fitted to
    this.rangePages = 0;
    this.historyPages = 0;
    this.historyBlocked = false;
    // Blank the chart at once: KLineChart keeps the previous series until the new init page arrives, which
    // could take several retries (old data must never sit under the new symbol / timeframe).
    this.installEmptyLoader();
    const ready = () => { if (this.loader === loader) this.onDataReady(); };
    const loader = createDataLoader({ session: () => p.session, pollMs: p.pollMs }, {
      onMeta: (m) => events.onMeta(m),
      // Never keep drawings hidden because a page failed; no automatic older page until data arrives again.
      onError: (e) => { this.historyBlocked = true; ready(); events.onError(e); },
      onConnection: (lost, e) => { if (lost) ready(); events.onConnection?.(lost, e); },
      onFatal: (e) => { ready(); events.onFatal?.(e); },
      onReload: () => { if (this.loader === loader) this.chart.resetData(); }, // gap too large to backfill
    });
    this.loader = loader;
    this.tf = p.tf;
    this.assetClass = p.symbol.assetClass;
    this.pricePrecision = p.symbol.pricePrecision;
    drawingConstraint.precision = p.symbol.pricePrecision;
    positionContext.barMs = tfMs(p.tf);
    positionContext.formatTime = barTimeFormat(p.tf, timezoneFor(p.symbol, p.tf));
    this.basketHasCrypto = p.symbol.assetClass === 'basket' && p.basketHasCrypto === true;
    // Same symbol, but daily-anchored drawings now display differently (daily ↔ intraday): re-place them.
    if (prevSymbol === p.symbol.id && prevMapping !== this.mapsDailyAnchors()) this.replaceForAnchorMapping(p.symbol.id);
    this.markers = [];
    this.renderMarkers();
    if (prevSymbol !== p.symbol.id) this.events = [];
    this.renderEvents();
    const ext: IndicatorExtendData = { assetClass: p.symbol.assetClass, intraday: isIntraday(p.tf), pricePrecision: p.symbol.pricePrecision };
    if (this.basketHasCrypto) ext.utcDays = true; // its intraday bars use the UTC grid
    this.setIndicatorContext(ext);
    const timezone = timezoneFor(p.symbol, p.tf);
    this.rangeTimeZone = timezone;
    this.chart.setTimezone(timezone);
    this.setTimeTexts(p.tf, timezone, p.session);
    this.chart.setSymbol({
      ticker: p.symbol.id,
      pricePrecision: p.symbol.pricePrecision,
      volumePrecision: p.symbol.assetClass === 'crypto' ? 4 : 0,
      // Extra keys feed the candle tooltip title template (see theme.ts).
      displayName: p.symbol.ticker,
      tf: p.tf,
    });
    this.chart.setPeriod(toPeriod(p.tf));
    // Installing the new loader last means only one 'init' request reaches the server.
    this.chart.setDataLoader({
      getBars: (params) => loader.getBars(params.type === 'init'
        ? { ...params, callback: (data, more) => { params.callback(data, more); ready(); } }
        : { ...params, callback: (data, more) => { if (data.length > 0) this.historyBlocked = false; params.callback(data, more); this.onBarsAdded(); } }),
      // New bars (polling / backfill) may make a marker placeable, e.g. a basket Start after the last bar.
      subscribeBar: (params) => loader.subscribeBar({ ...params, callback: (bar) => { this.historyBlocked = false; params.callback(bar); this.onBarsAdded(); } }),
      unsubscribeBar: () => loader.unsubscribeBar(),
    });
  }

  /**
   * Time texts of timeframe `tf` in the chart `timezone`: axis ticks with context ("Sep 21", "22", "13:30"), the
   * crosshair date chip and the last price capsule's bar-close countdown (shown for intraday / daily crypto bars).
   */
  private setTimeTexts(tf: Timeframe, timezone: string, session: SessionMode): void {
    this.chart.setFormatter({
      formatDate: ({ timestamp }) => crosshairDate(timestamp, tf, timezone),
      // Stock-like charts: the bar also closes with the session (16:00 / 20:00 New York).
      formatExtendText: ({ data }) => countdownText(data.timestamp, tf, Date.now(), this.stockLike() ? session : undefined),
    });
    this.chart.overrideXAxis({ createTicks: ({ range, bounding }) => this.axisTicks(range, bounding.width, tf, timezone) });
    this.chart.setStyles(this.styles());
  }

  /**
   * Time-axis ticks on calendar boundaries of the bars in view (see calendarTicks), placed at their bars; KLineChart's
   * own ticks fall every n bars whatever the date, so their labels would skip months unevenly. A tick whose label
   * would come within AXIS_EDGE_PX of the plot's edges is left out (it would be cut).
   */
  private axisTicks(range: { realFrom: number; realTo: number }, width: number, tf: Timeframe, timezone: string) {
    const data = this.chart.getDataList();
    const from = Math.max(0, Math.floor(range.realFrom) - 1); // the bar before the view: is the first one a boundary?
    const to = Math.min(data.length, Math.ceil(range.realTo));
    if (to - from < 2) return [];
    const times = data.slice(from, to).map((d) => d.timestamp);
    const tick: { size?: unknown; family?: unknown; weight?: unknown } = this.chart.getStyles?.()?.xAxis?.tickText ?? {};
    const tickWidth = (s: string) => textWidth(s, Number(tick.size ?? 11), String(tick.family ?? CHART_FONT), String(tick.weight ?? 'normal'));
    return calendarTicks(times, this.chart.getBarSpace().bar, tf, timezone).flatMap(({ index, label }) => {
      const at = from + index;
      const x = (this.chart.convertToPixel({ dataIndex: at }, { paneId: CANDLE_PANE }) as Partial<Coordinate>).x;
      if (x === undefined || !tickLabelFits(x, label, width, tickWidth)) return [];
      return [{ coord: x, value: data[at]!.timestamp, text: label }];
    });
  }

  /**
   * Stops loading/polling and blanks the chart (e.g. while the current symbol's info cannot be loaded), so
   * the previous symbol's data is neither shown nor polled any more. The next load() starts afresh.
   */
  clear(): void {
    this.range = null;
    this.clearMeasure();
    this.loader?.dispose();
    this.loader = null;
    this.dataSymbol = null;
    this.loadSymbol = null;
    this.markers = [];
    this.renderMarkers();
    this.events = [];
    this.renderEvents();
    this.installEmptyLoader();
  }

  /** A loader that answers 'init' with no data: installing it resets KLineChart to an empty series. */
  private installEmptyLoader(): void {
    this.chart.setDataLoader({ getBars: ({ callback }) => callback([], { forward: false, backward: false }) });
  }

  // ── appearance ────────────────────────────────────────────────────────────

  /** Phone width (see COMPACT_CANDLE_TOP_GAP_PX and chartStyles): a smaller legend with room above the bars. */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.chart.setStyles(this.styles());
    this.chart.overrideYAxis({ paneId: CANDLE_PANE, gap: compact ? { top: COMPACT_CANDLE_TOP_GAP_PX, bottom: DEFAULT_CANDLE_GAP.bottom } : DEFAULT_CANDLE_GAP });
  }

  setTheme(t: ThemeName): void {
    this.theme = t;
    refreshThemeTokens(t);
    this.updatePositionColors();
    this.updateIndicatorColors();
    this.chart.setStyles(this.styles());
    for (const o of this.chart.getOverlays({ groupId: MARKERS })) this.chart.overrideOverlay({ id: o.id, styles: markerStyles(t) });
    this.renderEvents(true); // the badges' colors are the theme's
    this.refreshLockedLook();
    this.refreshColorRefs();
    // Indicator lines without a color override carry the palette of the theme they were written in: rewrite
    // them, per line (width / style overrides kept; a palette reference resolves in the new theme, a hex stays).
    this.refreshIndicatorLines(() => true);
    this.refreshThemedBars();
    this.refreshMeasure();
    this.emitSelection(); // the style bar's swatches show this theme's colors
  }

  /** Rewrites every line of the indicators whose overrides match `which` (colors resolved again in the current theme). */
  private refreshIndicatorLines(which: (o: IndicatorOverrides) => boolean): void {
    for (const i of this.chart.getIndicators()) {
      const o = this.overrides.get(i.id) ?? {};
      if (!which(o)) continue;
      const styles = this.indicatorStyles(i.name, o, undefined, 'all-lines');
      if (styles?.lines) this.chart.overrideIndicator({ id: i.id, name: i.name, styles: { lines: styles.lines } });
    }
  }

  /**
   * Indicators without a bar-color override follow the chart styles, except those whose override was removed
   * (their defaults were written explicitly): give them the current default bars (theme / candle colors).
   */
  private refreshThemedBars(): void {
    if (this.themedBars.size === 0 && ![...this.overrides.values()].some((o) => o.barColors)) return;
    const d = this.chart.getStyles().indicator.bars[0]!;
    for (const i of this.chart.getIndicators()) {
      if (this.themedBars.has(i.id)) this.chart.overrideIndicator({ id: i.id, name: i.name, styles: { bars: [{ ...d, ...defaultIndicatorBars(this.theme, this.appearance) }] } });
      // A bar-color override may leave one side at its default (stored as the default color): that side follows.
      const stored = this.overrides.get(i.id)?.barColors;
      if (!stored) continue;
      const { up, down } = effectiveBarColors(this.theme, this.appearance, stored);
      if (up !== stored.up || down !== stored.down) this.chart.overrideIndicator({ id: i.id, name: i.name, styles: { bars: [{ ...d, upColor: up, downColor: down }] } });
    }
  }

  setChartType(t: ChartType): void {
    this.chartType = t;
    this.chart.setStyles(this.styles());
  }

  /**
   * Global chart appearance, per theme (candle colors/body, line color/width, default drawing style); the
   * active theme's settings apply (unset = theme defaults), and setTheme switches to the other theme's.
   */
  setAppearance(a: ThemedAppearance | undefined): void {
    this.appearance = a;
    this.updatePositionColors();
    this.updateIndicatorColors();
    this.chart.setStyles(this.styles());
    // Lines colored with the up / down reference follow the candle colors.
    this.refreshIndicatorLines((o) => o.lineColors?.some((c) => c === 'up' || c === 'down') === true);
    this.refreshThemedBars();
    this.refreshLockedLook();
    this.refreshColorRefs();
    this.refreshMeasure();
    this.renderEvents(true); // beats and misses take the candle colors
    this.emitSelection();
  }

  /** Global target / stop distances of new long / short positions (missing / invalid → app defaults); placed positions keep their prices. */
  setPositionDefaults(d: PositionDefaults | undefined): void {
    positionContext.defaults = resolvePositionDefaults(d);
  }

  setSessionShading(enabled: boolean): void {
    this.setShade(SESSION_SHADE, enabled);
  }

  private setShade(name: string, enabled: boolean): void {
    const existing = this.chart.getIndicators({ name });
    if (enabled && existing.length === 0) {
      this.chart.createIndicator({ name, paneId: CANDLE_PANE }, true);
    } else if (!enabled && existing.length > 0) {
      this.chart.removeIndicator({ name });
    }
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers;
    this.renderMarkers();
  }

  /** Marker overlays for the current data: one per marker at or after the first bar that has a bar to sit on. */
  private markerOverlays(): OverlayCreate[] {
    const data = this.chart.getDataList();
    const first = data[0];
    if (!first || this.markers.length === 0) return [];
    const width = this.tf ? tfMs(this.tf) : 0;
    const overlays: OverlayCreate[] = [];
    for (const m of this.markers) {
      if (m.ts < first.timestamp) continue;
      let i = lowerBound(data, m.ts);
      const prev = data[i - 1];
      // Prefer the bar that contains the marker (e.g. a mid-week date on a weekly chart).
      if (data[i]?.timestamp !== m.ts && prev && m.ts < prev.timestamp + width) i -= 1;
      const bar = data[i];
      if (!bar) continue;
      overlays.push({
        // Fixed theme style: markers never follow the user's default drawing style.
        name: MARKER_OVERLAY, groupId: MARKERS, lock: true, extendData: m.label, styles: markerStyles(this.theme),
        points: [{ timestamp: bar.timestamp, value: bar.high }],
      });
    }
    return overlays;
  }

  /** Which bar each rendered marker sits on (re-rendered only when that changes). */
  private markersKey = '';

  private renderMarkers(): void {
    this.withSilence(() => this.chart.removeOverlay({ groupId: MARKERS }));
    const overlays = this.markerOverlays();
    this.markersKey = JSON.stringify(overlays.map((o) => [o.extendData, o.points?.[0]?.timestamp]));
    for (const o of overlays) this.chart.createOverlay(o);
  }

  private onBarsAdded(): void {
    if (this.destroyed) return;
    this.ensurePositionHistory();
    this.continueRange();
    this.refreshMeasure(); // older bars shift the indexes: bars / volume are recounted from the bar times
    // The selected position's outcome follows new bars (polling / backfill).
    if (this.selectedId && this.userOverlays().some((o) => o.id === this.selectedId && isPositionTool(o.name))) this.emitSelection();
    if (this.events.length > 0) this.renderEvents();
    if (this.markers.length === 0) return;
    const key = JSON.stringify(this.markerOverlays().map((o) => [o.extendData, o.points?.[0]?.timestamp]));
    if (key !== this.markersKey) this.renderMarkers();
  }

  // ── corporate events ──────────────────────────────────────────────────────

  /**
   * The charted stock's earnings, dividends and splits, and the kinds to leave out: drawn as badges at the bottom of
   * the price pane on the bars they fall in (kept across timeframe changes of the same symbol; a new symbol clears them).
   */
  setEvents(events: CorporateEvent[], hidden: CorporateEventKind[] = []): void {
    this.events = events;
    this.hiddenEvents = hidden;
    this.renderEvents();
  }

  /** Fired when the mouse enters a bar's badges (where they sit and the events) and leaves them (null). */
  onEventHover(cb: (h: EventHover | null) => void): () => void {
    this.eventHoverListeners.add(cb);
    return () => { this.eventHoverListeners.delete(cb); };
  }

  /** Fired with the event groups drawn whenever they change (e.g. for a screen-reader list). */
  onEventsShown(cb: (groups: EventGroup[]) => void): () => void {
    this.eventsShownListeners.add(cb);
    cb(this.eventGroupsShown);
    return () => { this.eventsShownListeners.delete(cb); };
  }

  /** Redraws the badges when the groups changed (or always, with `force`: new colors). */
  private renderEvents(force = false): void {
    const data = this.chart.getDataList();
    const groups = this.tf ? eventGroups(this.events, data, tfMs(this.tf), this.hiddenEvents) : [];
    const key = JSON.stringify(groups);
    if (!force && key === this.eventsKey) return;
    this.eventsKey = key;
    this.withSilence(() => this.chart.removeOverlay({ groupId: EVENTS }));
    this.eventOverlayGroups.clear();
    this.emitEventHover(null);
    for (const g of groups) {
      const extendData: EventOverlayData = { badges: groupBadges(g, this.theme, this.appearance) };
      const id = this.chart.createOverlay({
        name: EVENT_OVERLAY, groupId: EVENTS, lock: true, extendData, points: [{ timestamp: g.barTs, value: 0 }],
        onMouseEnter: ({ overlay }) => { this.hoverEventGroup(overlay.id); },
        onMouseLeave: () => { this.emitEventHover(null); },
      });
      if (typeof id === 'string') this.eventOverlayGroups.set(id, g);
    }
    if (key !== JSON.stringify(this.eventGroupsShown)) {
      this.eventGroupsShown = groups;
      for (const cb of this.eventsShownListeners) cb(groups);
    }
  }

  private hoverEventGroup(overlayId: string): void {
    const group = this.eventOverlayGroups.get(overlayId);
    if (!group) return;
    const pane = this.chart.getSize(CANDLE_PANE);
    const px = this.chart.convertToPixel({ timestamp: group.barTs }, { paneId: CANDLE_PANE, absolute: true }) as Partial<Coordinate>;
    if (!pane || typeof px.x !== 'number') return;
    const kinds = new Set(group.events.map((e) => e.kind)).size;
    this.emitEventHover({ events: group.events, x: px.x, y: pane.top + pane.height - badgeStackHeight(kinds) });
  }

  private emitEventHover(h: EventHover | null): void {
    if (this.destroyed) return;
    for (const cb of this.eventHoverListeners) cb(h);
  }

  // ── indicators ────────────────────────────────────────────────────────────

  /** Default lines of indicator `name`: KLineChart's line style with the active theme's palette color per slot. */
  private defaultLines(name: string): IndicatorStyle['lines'] {
    const base = this.chart.getStyles().indicator.lines;
    const n = Math.max(catalogEntry(name)?.lines.length ?? 0, base.length);
    return Array.from({ length: n }, (_, i) => ({ ...base[i % base.length]!, color: defaultLineColor(i, name, this.theme) }));
  }

  /**
   * KLineChart styles for the overrides; `reset` lists the kinds (lines / bars) that had overrides before and
   * must be written back to their defaults explicitly when they are gone (KLineChart merges override styles).
   */
  private indicatorStyles(name: string, o: IndicatorOverrides, reset?: IndicatorOverrides, force: false | true | 'all-lines' = false): DeepPartial<IndicatorStyle> | undefined {
    const styles: DeepPartial<IndicatorStyle> = {};
    const hasLines = Boolean(o.lineColors || o.lineWidths || o.lineStyles);
    const lineCount = catalogEntry(name)?.lines.length ?? 0;
    if (hasLines || (reset && (reset.lineColors || reset.lineWidths || reset.lineStyles)) || (force && lineCount > 0)) {
      const defaults = this.defaultLines(name);
      // A palette reference resolves in the active theme (re-run on theme and candle color changes); a hex is drawn as is.
      const lineColor = (c: string | undefined) => (c !== undefined && isDrawingColorToken(c) ? resolvePaletteColor(c, this.theme, this.appearance) : c);
      // Every catalog line is written, always: KLineChart merges style arrays by index, so a line past a shorter
      // override array would otherwise keep its previous override (and lines past a partial array would keep
      // KLineChart's defaults instead of the theme palette). Uncatalogued indicators: the longer of both lists.
      const overridden = Math.max(o.lineColors?.length ?? 0, o.lineWidths?.length ?? 0, o.lineStyles?.length ?? 0);
      const n = lineCount > 0 ? lineCount : Math.max(overridden, defaults.length);
      styles.lines = Array.from({ length: n }, (_, i) => {
        const d = defaults[i % defaults.length]!;
        const style = o.lineStyles?.[i] ?? 'solid';
        const size = o.lineWidths?.[i] ?? 1;
        const line = klineLine(style, size, INDICATOR_DASH);
        return {
          ...d,
          color: lineColor(lineColorOverride(name, i, o.lineColors?.[i])) ?? d.color,
          size,
          ...line,
          dashedValue: style === 'solid' ? d.dashedValue : line.dashedValue,
        };
      });
    }
    if (o.barColors || reset?.barColors) {
      const d = this.chart.getStyles().indicator.bars[0]!;
      const b = o.barColors ? effectiveBarColors(this.theme, this.appearance, o.barColors) : null;
      styles.bars = [b ? { ...d, upColor: b.up, downColor: b.down } : { ...d, ...defaultIndicatorBars(this.theme, this.appearance) }];
    }
    return styles.lines || styles.bars ? styles : undefined;
  }

  private static overridesOf(spec: Partial<IndicatorSpec>): IndicatorOverrides {
    const o: IndicatorOverrides = {};
    if (spec.lineColors) o.lineColors = spec.lineColors;
    if (spec.lineWidths) o.lineWidths = spec.lineWidths;
    if (spec.lineStyles) o.lineStyles = spec.lineStyles;
    if (spec.barColors) o.barColors = spec.barColors;
    if (spec.levels) o.levels = spec.levels;
    if (spec.showLevels === false) o.showLevels = false;
    return o;
  }

  /**
   * Reference levels (dashed lines such as RSI 70 / 30) as indicator fields: a `draw` callback that strokes them
   * behind the figures (composed with a custom template's own `draw`) and y-range bounds that keep them in view.
   * Null for indicators without catalog levels (their template's draw / range stay untouched).
   */
  private levelFields(name: string, spec: Partial<IndicatorSpec>): Pick<IndicatorCreate, 'draw' | 'minValue' | 'maxValue'> | null {
    if (!catalogEntry(name)?.levels) return null;
    const levels = effectiveLevels({ name, levels: spec.levels, showLevels: spec.showLevels });
    const inner = CUSTOM_INDICATORS.find((c) => c.template.name === name)?.template.draw as IndicatorDrawCallback<unknown, unknown, unknown> | null | undefined;
    return { draw: levelsDraw(levels, () => indicatorLevelColor(this.theme), inner), ...levelsRange(levels) };
  }

  addIndicator(spec: IndicatorSpec): string {
    const main = spec.pane === 'main';
    const create: IndicatorCreate = { name: spec.name };
    if (main) create.paneId = CANDLE_PANE;
    if (spec.calcParams) create.calcParams = spec.calcParams;
    if (spec.visible !== undefined) create.visible = spec.visible;
    const overrides = ChartAdapter.overridesOf(spec);
    // Always written (force), every catalog line: the lines carry the active theme's palette (a template's own
    // color would stick), including lines past a partial override array such as lineWidths: [3].
    const styles = this.indicatorStyles(spec.name, overrides, undefined, true);
    if (styles) create.styles = styles;
    create.extendData = this.indicatorExt;
    const precision = indicatorPrecision(spec.name, this.indicatorExt.pricePrecision ?? 4);
    if (precision !== undefined) create.precision = precision;
    const levels = this.levelFields(spec.name, spec);
    if (levels) Object.assign(create, levels);
    const id = this.chart.createIndicator(create, main);
    if (!id) throw new Error(`Cannot create indicator ${spec.name}`);
    if (levels) this.drawnLevels.set(id, JSON.stringify(effectiveLevels(spec)));
    // Histogram bars are always filled (MACD / AO outline rising bars by default): falling ones in the soft tone.
    const created = this.chart.getIndicators().find((i) => i.id === id);
    const figures = solidBarFigures(created?.figures, (c) => themeSoftTone(this.theme, c));
    // Bar and SAR dot values in the legend take the up / down TEXT tones (never the faint soft tone of a falling bar).
    const legends = created?.figures?.some((f) => f.type === 'bar' || f.type === 'circle') ? { createTooltipDataSource: this.barLegends } : {};
    if (figures || 'createTooltipDataSource' in legends) this.chart.overrideIndicator({ id, name: spec.name, ...(figures ? { figures } : {}), ...legends });
    if (hasOverrides(overrides)) this.overrides.set(id, overrides);
    return id;
  }

  private readonly barLegends = textColoredLegends(() => {
    const t = themeTokens(this.theme);
    return { up: t.up, down: t.down, upFg: t.upFg, downFg: t.downFg, soften: (c: string) => themeSoftTone(this.theme, c) };
  });

  /** Absent style fields in `spec` remove that override (the defaults are written back). */
  updateIndicator(id: string, spec: Partial<IndicatorSpec>): void {
    const existing = this.chart.getIndicators().find((i) => i.id === id);
    if (!existing) return;
    const override: IndicatorCreate = { id, name: existing.name };
    if (spec.calcParams) override.calcParams = spec.calcParams;
    if (spec.visible !== undefined) override.visible = spec.visible;
    const next = ChartAdapter.overridesOf(spec);
    const styles = this.indicatorStyles(existing.name, next, this.overrides.get(id));
    if (styles) override.styles = styles;
    // Levels are rewritten only when the drawn set changes (a new draw callback makes KLineChart redraw).
    const levelsKey = JSON.stringify(effectiveLevels({ name: existing.name, ...next }));
    if (this.drawnLevels.has(id) && this.drawnLevels.get(id) !== levelsKey) {
      Object.assign(override, this.levelFields(existing.name, next));
      this.drawnLevels.set(id, levelsKey);
    }
    this.chart.overrideIndicator(override);
    if (next.barColors) this.themedBars.delete(id);
    else if (this.overrides.get(id)?.barColors) this.themedBars.add(id); // defaults written back explicitly
    if (hasOverrides(next)) this.overrides.set(id, next);
    else this.overrides.delete(id);
  }

  /** Updates the indicators' extendData (asset class, intraday, price precision) when it changes. */
  private setIndicatorContext(ext: IndicatorExtendData): void {
    const cur = this.indicatorExt;
    if (cur.assetClass === ext.assetClass && cur.intraday === ext.intraday && cur.pricePrecision === ext.pricePrecision && cur.utcDays === ext.utcDays) return;
    this.indicatorExt = ext;
    for (const i of this.chart.getIndicators()) {
      if (SHADE_INDICATORS.has(i.name)) continue;
      const override: IndicatorCreate = { id: i.id, name: i.name, extendData: ext };
      // Bounded oscillators keep their fixed precision; price-unit ones follow the symbol.
      if (!BOUNDED_INDICATORS.has(i.name)) {
        const precision = indicatorPrecision(i.name, ext.pricePrecision ?? 4);
        if (precision !== undefined) override.precision = precision;
      }
      this.chart.overrideIndicator(override);
    }
  }

  removeIndicator(id: string): void {
    this.chart.removeIndicator({ id });
    this.overrides.delete(id);
    this.themedBars.delete(id);
    this.drawnLevels.delete(id);
  }

  listIndicators(): Array<{ id: string } & IndicatorSpec> {
    return this.chart.getIndicators()
      .filter((i) => !SHADE_INDICATORS.has(i.name))
      .map((i) => {
        const spec: { id: string } & IndicatorSpec = {
          id: i.id,
          name: i.name,
          pane: i.paneId === CANDLE_PANE ? 'main' : 'sub',
          calcParams: i.calcParams as number[],
          visible: i.visible,
        };
        Object.assign(spec, this.overrides.get(i.id));
        return spec;
      });
  }

  // ── drawings ──────────────────────────────────────────────────────────────

  /** Overlay id of the drawing currently selected by the user (KLineChart onSelected/onDeselected). */
  private selectedId: string | null = null;
  /** Overlay id + completion callback of the drawing being placed interactively. */
  private drawing: { id: string; onEnd?: () => void } | null = null;
  private magnet = false;
  /** "Lock all drawings": every user drawing is locked, on top of its own lock. */
  private lockAll = false;
  /** Overlay ids of the drawings locked on their own (style bar lock toggle); they stay locked when "Lock all" goes off. */
  private readonly ownLocks = new Set<string>();
  /** Symbol of the current load(); dataSymbol becomes it once that load's first data page arrived. */
  private loadSymbol: string | null = null;
  private dataSymbol: string | null = null;
  /** Drawings queued by restoreDrawings until data for their symbol (or any data, if unspecified) is in. */
  private pendingRestore: { drawings: DrawingState[]; symbol?: string } | null = null;
  private readonly lockListeners = new Set<(locked: boolean) => void>();
  /** KLineChart fires onRemoved while the overlay is still listed; hide it from serializeDrawings meanwhile. */
  private readonly removing = new Set<string>();

  /** Meta (macOS) / Ctrl held: the active drawing snaps with 'strong_magnet'. */
  private strongMagnet = false;
  /** Overlay being dragged (onPressedMoveStart … onPressedMoveEnd). */
  private draggingId: string | null = null;
  /** Overlays whose mode was switched to strong_magnet (reverted when they stop being active). */
  private readonly strongIds = new Set<string>();
  private readonly selectionListeners = new Set<(s: SelectedDrawing | null) => void>();
  private readonly priceEditListeners = new Set<(id: string) => void>();
  /** Price precision of the current symbol (horizontal drawings placed with the mouse are rounded to it). */
  private pricePrecision = 2;

  private readonly handlers: Pick<OverlayCreate, 'onDrawEnd' | 'onPressedMoveStart' | 'onPressedMoving' | 'onPressedMoveEnd' | 'onRemoved' | 'onSelected' | 'onDeselected' | 'onDoubleClick' | 'onRightClick'> = {
    onDrawEnd: ({ overlay }) => {
      if (this.drawing?.id === overlay.id) {
        const { onEnd } = this.drawing;
        this.drawing = null;
        if (this.degenerateRectangle(overlay)) {
          // Two clicks on one row or column of pixels make no box: nothing is drawn (or saved).
          this.withSilence(() => this.chart.removeOverlay({ id: overlay.id }));
          onEnd?.();
          return;
        }
        if (this.lockAll) this.applyLock(overlay.id);
        this.revertMode(overlay.id);
        this.anchorAfterEdit(overlay.id);
        this.roundHorizontal(overlay);
        this.placePosition(overlay);
        onEnd?.();
        this.emitSelection(); // the style bar is hidden while a drawing is being placed
      }
      this.emitChange();
    },
    onPressedMoveStart: ({ overlay }) => {
      this.draggingId = overlay.id;
      drawingConstraint.draggingId = overlay.id;
      this.pressedPoints.set(overlay.id, completePoints(overlay));
      if (this.strongMagnet) this.applyStrong(overlay.id);
    },
    // Shift held: a whole-drawing drag keeps it horizontal (point drags are constrained by the template).
    onPressedMoving: ({ overlay }) => {
      if (drawingConstraint.shift && SHIFT_TOOLS.has(overlay.name)) flattenBase(overlay.name, overlay.points, this.pricePrecision);
      return false;
    },
    onPressedMoveEnd: ({ overlay }) => {
      if (this.draggingId === overlay.id) this.draggingId = null;
      if (drawingConstraint.draggingId === overlay.id) drawingConstraint.draggingId = null;
      this.revertMode(overlay.id);
      // KLineChart fires press start/end on a plain click too: only a real move changes the anchoring.
      const before = this.pressedPoints.get(overlay.id);
      this.pressedPoints.delete(overlay.id);
      const after = completePoints(overlay);
      if (before && after && samePoints(before, after)) return;
      this.anchorAfterEdit(overlay.id);
      this.roundHorizontal(overlay);
      if (isPositionTool(overlay.name) && before && after && after.some((p) => p.value <= 0)) {
        // A whole-position drag (KLineChart shifts the prices freely) never takes a price to zero or below.
        this.chart.overrideOverlay({ id: overlay.id, points: before });
        return;
      }
      this.roundPosition(overlay);
      this.emitChange();
      if (isPositionTool(overlay.name)) {
        this.ensurePositionHistory();
        if (this.selectedId === overlay.id) this.emitSelection();
      }
    },
    onRemoved: ({ overlay }) => {
      if (this.selectedId === overlay.id) this.select(null);
      if (this.drawing?.id === overlay.id) this.endDrawing();
      if (this.draggingId === overlay.id) this.draggingId = null;
      if (drawingConstraint.draggingId === overlay.id) drawingConstraint.draggingId = null;
      this.strongIds.delete(overlay.id);
      this.ownLocks.delete(overlay.id);
      this.anchors.delete(overlay.id);
      this.pressedPoints.delete(overlay.id);
      this.removing.add(overlay.id);
      try { this.emitChange(); } finally { this.removing.delete(overlay.id); }
    },
    // KLineChart removes an overlay on right click unless prevented (it ignores the lock): locked ones stay.
    onRightClick: ({ overlay, preventDefault }) => { if (overlay.lock) preventDefault?.(); },
    onSelected: ({ overlay }) => { this.select(overlay.id); },
    onDeselected: ({ overlay }) => { if (this.selectedId === overlay.id) this.select(null); },
    // Double-clicking a horizontal line selects it and asks the style bar to focus its price field.
    onDoubleClick: ({ overlay }) => {
      if (!HORIZONTAL_DRAWINGS.has(overlay.name) || overlay.id === this.drawing?.id) return false;
      if (this.selectedId !== overlay.id) this.select(overlay.id);
      for (const cb of this.priceEditListeners) cb(overlay.id);
      return false;
    },
  };

  /**
   * A rectangle just placed with zero width or height on screen (both clicks in one bar, or at one price). Only at
   * placement: a stored rectangle that collapses on another timeframe is kept (its border stays grabbable).
   */
  private degenerateRectangle(overlay: Overlay): boolean {
    if (overlay.name !== RECTANGLE) return false;
    const [a, b] = overlay.points;
    if (!a || !b) return true;
    const px = this.chart.convertToPixel([a, b], { paneId: CANDLE_PANE }) as Array<Partial<Coordinate>>;
    const [pa, pb] = px;
    if (typeof pa?.x !== 'number' || typeof pa.y !== 'number' || typeof pb?.x !== 'number' || typeof pb.y !== 'number') return false;
    return isDegenerateBox({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y });
  }

  /** Rounds a horizontal drawing placed / moved with the mouse to the symbol's price precision. */
  private roundHorizontal(overlay: Overlay): void {
    if (!HORIZONTAL_DRAWINGS.has(overlay.name)) return;
    const points = completePoints(overlay);
    if (!points) return;
    const rounded = points.map((p) => ({ ...p, value: roundPrice(p.value, this.pricePrecision) }));
    if (!samePoints(points, rounded)) this.chart.overrideOverlay({ id: overlay.id, points: rounded });
  }

  // ── long / short positions ──

  /** Default end of a position starting at `start`: ≈ 20 bars later (the loaded bars, then the timeframe). */
  private positionEnd(start: number): number {
    return endAfterBars(this.chart ? this.chart.getDataList() : [], start, DEFAULT_WIDTH_BARS, positionContext.barMs);
  }

  /** Older-data pages requested for positions since the current load (bounded by MAX_HISTORY_PAGES). */
  private historyPages = 0;
  /** An older page failed: no automatic page until the next successful data event or load() (no offline bursts). */
  private historyBlocked = false;

  /** KLineChart's internal store (10.0.3): whether older data exists, and the loader of older pages. */
  private dataStore(): { _loading?: boolean; _dataLoadMore?: { forward?: boolean }; _processDataLoad?: (type: string) => void } | null {
    const c = this.chart as unknown as { getChartStore?: () => unknown };
    try {
      return (c.getChartStore?.() as ReturnType<ChartAdapter['dataStore']>) ?? null;
    } catch {
      return null;
    }
  }

  /** True while KLineChart may load older bars (unknown → false: the loaded bars are taken as complete). */
  private hasOlderData(): boolean {
    return this.dataStore()?._dataLoadMore?.forward === true;
  }

  /**
   * Requests an older page while a position starts before the first loaded bar and older data exists, so its
   * outcome can be evaluated (each page arriving calls this again; at most MAX_HISTORY_PAGES per load, then the
   * position shows "Outcome needs earlier data").
   */
  private ensurePositionHistory(): void {
    if (this.historyBlocked || this.historyPages >= MAX_HISTORY_PAGES || !this.hasOlderData()) return;
    const first = this.chart.getDataList()[0];
    if (!first) return;
    let earliest = Infinity;
    for (const o of this.userOverlays()) {
      if (!isPositionTool(o.name)) continue;
      const t = o.points[0]?.timestamp;
      if (typeof t === 'number' && t < earliest) earliest = t;
    }
    if (!(earliest < first.timestamp)) return;
    const store = this.dataStore();
    const load = store?._processDataLoad;
    // KLineChart ignores a request while it is loading: such calls do not count toward the cap.
    if (typeof load !== 'function' || store?._loading === true) return;
    this.historyPages++;
    try { load.call(store, 'forward'); } catch { /* internal API changed: the outcome shows it needs data */ }
  }

  /**
   * A position placed with one click: entry rounded to the symbol precision, target / stop at the default distances
   * (±2 % unless changed with "Use as default"), end ≈ 20 bars later.
   */
  private placePosition(overlay: Overlay): void {
    const side = sideOf(overlay.name);
    const p0 = overlay.points[0];
    if (!side || typeof p0?.timestamp !== 'number' || typeof p0.value !== 'number') return;
    const g = defaultGeometry(side, p0.timestamp, p0.value, this.positionEnd(p0.timestamp), this.pricePrecision, positionContext.defaults);
    this.chart.overrideOverlay({ id: overlay.id, points: toPositionPoints(g) });
  }

  /** Rounds the prices of a position moved as a whole with the mouse (KLineChart shifts them unrounded). */
  private roundPosition(overlay: Overlay): void {
    if (!isPositionTool(overlay.name)) return;
    const points = completePoints(overlay);
    if (!points) return;
    const rounded = points.map((p) => ({ ...p, value: roundPrice(p.value, this.pricePrecision) }));
    if (!samePoints(points, rounded)) this.chart.overrideOverlay({ id: overlay.id, points: rounded });
  }

  /**
   * Sets the selected position's entry / target / stop (rounded to the symbol precision; times unchanged, so the
   * anchoring is kept). Returns an error message (nothing changes) for invalid prices (long: stop < entry < target,
   * short inverted), a locked position or no position selected; null when applied (saved like any edit).
   */
  setSelectedPositionPrices(patch: { entry?: number; target?: number; stop?: number }): string | null {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.kind !== 'position') return 'No position selected';
    if (sel.locked) return 'The position is locked';
    const r = (v: number | undefined, cur: number) => (v === undefined ? cur : roundPrice(v, this.pricePrecision));
    const next = { entry: r(patch.entry, sel.entry), target: r(patch.target, sel.target), stop: r(patch.stop, sel.stop) };
    const error = validatePrices(sel.side, next);
    if (error) return error;
    const o = this.userOverlays().find((x) => x.id === sel.id);
    const g = o ? fromPositionPoints(o.points) : null;
    if (!o || !g) return 'No position selected';
    this.setValues(sel.id, toPositionPoints({ ...g, ...next }));
    this.emitChange();
    this.emitSelection();
    return null;
  }

  /** Moves an overlay's points to `next` (same times, new prices), keeping the stored daily points of a remapped anchor. */
  private setValues(id: string, next: Point[]): void {
    this.chart.overrideOverlay({ id, points: next });
    const anchor = this.anchors.get(id);
    if (anchor?.display && anchor.original) {
      anchor.display = next;
      anchor.original = anchor.original.map((p, i) => ({ ...p, value: next[i]?.value ?? p.value }));
    }
  }

  // ── daily-anchored drawings ──
  // Daily+ bars of stocks/baskets are stamped at UTC midnight (20:00 New York the evening before). A drawing
  // placed on such a chart stores `anchorTf`; on intraday stock/basket charts its points are shown at 09:30
  // New York of their dates and saved back unchanged unless the user moves it there (then anchorTf is dropped).

  /** Per user overlay: its anchor and, while shown remapped, the stored points and the displayed ones. */
  private readonly anchors = new Map<string, { anchorTf: AnchorTf; original?: Point[]; display?: Point[] }>();
  /** Points of an overlay when a press on it started (a press without movement changes nothing). */
  private readonly pressedPoints = new Map<string, Point[] | null>();

  /** Stock or stock-only basket: daily bars at UTC midnight, intraday bars on the New York session grid. */
  private stockLike(): boolean {
    return this.assetClass === 'stock' || (this.assetClass === 'basket' && !this.basketHasCrypto);
  }

  /** True when daily-anchored points are remapped for display (intraday stock/basket chart). */
  private mapsDailyAnchors(): boolean {
    return this.stockLike() && this.tf !== null && isIntraday(this.tf);
  }

  /** After a user draws or moves `id`: daily semantics on a daily+ stock/basket chart, else plain points. */
  private anchorAfterEdit(id: string): void {
    const anchorTf = this.stockLike() && this.tf ? anchorTfOf(this.tf) : null;
    if (anchorTf) this.anchors.set(id, { anchorTf });
    else this.anchors.delete(id);
  }

  /** Re-creates the user drawings (once data is in) so anchored ones follow the new display mapping. */
  private replaceForAnchorMapping(symbol: string): void {
    if (this.pendingRestore === null && this.anchors.size === 0) return;
    const saved = this.pendingRestore?.drawings ?? this.serializeDrawings();
    this.cancelDrawing();
    this.withSilence(() => this.removeUserOverlays());
    this.dataSymbol = null;
    this.pendingRestore = { drawings: saved, symbol };
  }

  // ── quick clicks while placing a drawing ──
  // KLineChart 10 treats a second press within 500 ms of the first as a double-click. If it is ≥ 5 px away it
  // fires neither a click nor a double-click, so the second point of a quick two-click trend line was lost.
  // While a drawing is being placed, a press that is not a deliberate double-click (same spot, < 500 ms)
  // restarts KLineChart's click sequence first, so its mouseup counts as an ordinary click.

  private lastPress: { x: number; y: number; t: number } | null = null;

  private readonly onPressCapture = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (this.measurePress(e)) return;
    const prev = this.lastPress;
    const now = Date.now();
    this.lastPress = { x: e.clientX, y: e.clientY, t: now };
    if (!this.drawing) return;
    const doubleClick = prev !== null && now - prev.t < DOUBLE_CLICK_MS
      && Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) < DOUBLE_CLICK_PX;
    if (doubleClick) return;
    // Internal (KLineChart 10.0.3: chart._chartEvent._event._resetClickTimeout); a no-op if it ever changes.
    const handler = (this.chart as unknown as { _chartEvent?: { _event?: { _resetClickTimeout?: unknown } } })._chartEvent?._event;
    if (handler && typeof handler._resetClickTimeout === 'function') {
      try { (handler._resetClickTimeout as () => void).call(handler); } catch { /* keep KLineChart's behavior */ }
    }
  };

  private baseMode(): OverlayMode {
    return this.magnet ? 'weak_magnet' : 'normal';
  }

  private applyStrong(id: string): void {
    this.strongIds.add(id);
    this.chart.overrideOverlay({ id, mode: 'strong_magnet' });
  }

  private revertMode(id: string): void {
    if (!this.strongIds.delete(id)) return;
    this.chart.overrideOverlay({ id, mode: this.baseMode() });
  }

  /**
   * While Meta (macOS) / Ctrl is held the drawing being placed or dragged snaps to OHLC values
   * ('strong_magnet'); on release it reverts to the toolbar magnet mode.
   */
  setMagnetOverride(on: boolean): void {
    if (this.strongMagnet === on) return;
    this.strongMagnet = on;
    const active = [this.drawing?.id, this.draggingId].filter((x): x is string => typeof x === 'string');
    for (const id of new Set(active)) {
      if (on) this.applyStrong(id);
      else this.revertMode(id);
    }
  }

  // ── selection style ──

  private select(id: string | null): void {
    this.selectedId = id;
    drawingContext.selectedId = id;
    this.emitSelection();
  }

  private emitSelection(): void {
    if (this.destroyed) return;
    const s = this.getSelectedDrawing();
    for (const cb of this.selectionListeners) cb(s);
  }

  /** Fired when the selected drawing (or its style) changes; null when nothing is selected. */
  onSelectionChange(cb: (s: SelectedDrawing | null) => void): () => void {
    this.selectionListeners.add(cb);
    return () => { this.selectionListeners.delete(cb); };
  }

  /**
   * Effective (normalized) style of the selected user drawing: its own styles, else the chart's overlay defaults
   * (the appearance's default drawing style). Null while nothing is selected or the drawing is still being placed.
   */
  getSelectedDrawing(): SelectedDrawing | null {
    const id = this.selectedId;
    if (!id || id === this.drawing?.id) return null;
    const o = this.userOverlays().find((x) => x.id === id);
    if (!o) return null;
    const d = this.storedDefaultDrawing();
    if (o.name === TEXT_TOOL) {
      const style = readText(o.styles) ?? { color: readOwnColor(o.styles) ?? d.color, size: DEFAULT_TEXT_SIZE };
      return { id: o.id, kind: 'text', style, ...this.lockOf(o) };
    }
    const side = sideOf(o.name);
    if (side) {
      const g = fromPositionPoints(o.points);
      if (!g) return null;
      const { metrics, outcome } = positionState({
        id: o.id, side, g, bars: this.chart.getDataList() as OutcomeBar[],
        historyComplete: !this.hasOlderData(), barMs: positionContext.barMs,
      });
      return {
        id: o.id, kind: 'position', side, ...this.lockOf(o), entry: g.entry, target: g.target, stop: g.stop, precision: this.pricePrecision,
        metrics, outcome,
      };
    }
    const style = readLine(o.styles) ?? { ...d, color: readOwnColor(o.styles) ?? d.color };
    const sel: SelectedDrawing = { id: o.id, kind: 'line', name: o.name, style, ...this.lockOf(o) };
    const value = o.points[0]?.value;
    if (HORIZONTAL_DRAWINGS.has(o.name) && typeof value === 'number') sel.price = { value, precision: this.pricePrecision };
    const label = labelOptions(o.name, o.styles);
    if (label) sel.label = label;
    const extend = extendOptions(o.name, o.styles);
    if (extend) sel.extend = extend;
    const fill = fillOption(o.name, o.styles);
    if (fill !== null) sel.fill = fill;
    return sel;
  }

  private lockOf(o: Overlay): SelectedLock {
    return { locked: o.lock, ownLock: this.ownLocks.has(o.id) };
  }

  /**
   * Locks / unlocks the selected drawing on its own (it cannot be moved, edited or removed while locked; "Lock all"
   * locks it too, whatever this says). Saved like any drawing edit. False when nothing is selected.
   */
  setSelectedLock(locked: boolean): boolean {
    const sel = this.getSelectedDrawing();
    if (!sel) return false;
    if (locked) this.ownLocks.add(sel.id);
    else this.ownLocks.delete(sel.id);
    this.applyLock(sel.id);
    this.emitChange();
    this.emitSelection();
    return true;
  }

  /**
   * Handles of a locked drawing: hollow rings (the theme background inside, a 1.5 px ring in the default drawing
   * color), as wide as the default filled dot (radius 5 + border 1) and the same size on hover, since they cannot be
   * dragged.
   */
  private lockedPoint(): DeepPartial<OverlayStyle['point']> {
    const bg = themeTokens(this.theme).bg;
    const ring = this.defaultDrawing().color;
    return {
      color: bg, borderColor: ring, borderSize: 1.5, radius: 4.5,
      activeColor: bg, activeBorderColor: ring, activeBorderSize: 1.5, activeRadius: 4.5,
    };
  }

  /** Effective lock of a drawing ("Lock all" or its own lock), with the matching handle look. True when it changed. */
  private applyLock(id: string, force = false): boolean {
    const o = this.userOverlays().find((x) => x.id === id);
    if (!o) return false;
    const locked = this.lockAll || this.ownLocks.has(id);
    if (!force && o.lock === locked) return false;
    // A null point style drops the override (KLineChart merges styles, null replaces the key): default handles again.
    const point = locked ? this.lockedPoint() : null;
    this.chart.overrideOverlay({ id, lock: locked, styles: { point } as unknown as DeepPartial<OverlayStyle> });
    return true;
  }

  /** Re-applies the locked handle look (the theme or the default drawing color changed). */
  private refreshLockedLook(): void {
    for (const o of this.userOverlays()) if (o.lock) this.applyLock(o.id, true);
  }

  /** Changes the selected channel's extend options; saved like any drawing edit. */
  setSelectedExtend(patch: Partial<ExtendOptions>): void {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.kind !== 'line' || !sel.extend || sel.locked) return;
    const next = { ...sel.extend, ...patch };
    this.chart.overrideOverlay({ id: sel.id, styles: { [EXTEND_STYLE_KEY]: next } as DeepPartial<OverlayStyle> });
    this.emitChange();
    this.emitSelection();
  }

  /** Turns the selected rectangle's fill on / off; saved like any drawing edit. */
  setSelectedFill(on: boolean): void {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.kind !== 'line' || sel.fill === undefined || sel.locked || sel.fill === on) return;
    this.chart.overrideOverlay({ id: sel.id, styles: { [FILL_STYLE_KEY]: on } as DeepPartial<OverlayStyle> });
    this.emitChange();
    this.emitSelection();
  }

  /** Changes the selected price / horizontal line's label options; saved like any drawing edit. */
  setSelectedLabel(patch: Partial<LabelOptions>): void {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.kind !== 'line' || !sel.label || sel.locked) return;
    const next = { ...sel.label, ...patch };
    this.chart.overrideOverlay({ id: sel.id, styles: { [LABEL_STYLE_KEY]: next } as DeepPartial<OverlayStyle> });
    this.emitChange();
    this.emitSelection();
  }

  /** Shift held (toolbar): trend lines, rays, extended lines and channels being placed or dragged stay horizontal. */
  setShiftConstraint(on: boolean): void {
    drawingConstraint.shift = on;
  }

  /**
   * Moves the selected horizontal drawing to `price` (rounded to MAX_PRICE_DECIMALS): every point gets that
   * value and keeps its timestamp, so the anchoring (anchorTf, stored daily timestamps) is unchanged. Saved like
   * any drawing edit. False (nothing changes) for an invalid price or no unlocked horizontal drawing selected.
   */
  setSelectedPrice(price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    const sel = this.getSelectedDrawing();
    if (!sel || sel.kind !== 'line' || !sel.price || sel.locked) return false;
    const o = this.userOverlays().find((x) => x.id === sel.id);
    const points = o ? completePoints(o) : null;
    if (!points) return false;
    const value = roundPrice(price, MAX_PRICE_DECIMALS);
    // Shown remapped: the stored daily points take the new price too (still "unmoved" in time).
    this.setValues(sel.id, points.map((p) => ({ ...p, value })));
    this.emitChange();
    this.emitSelection();
    return true;
  }

  /** Fired with its id when the user double-clicks a horizontal drawing (selected first). Returns an unsubscribe. */
  onPriceEditRequest(cb: (id: string) => void): () => void {
    this.priceEditListeners.add(cb);
    return () => { this.priceEditListeners.delete(cb); };
  }

  /** Deselects the selected drawing (Escape); the style bar closes. */
  deselect(): void {
    const id = this.selectedId;
    if (!id) return;
    // KLineChart has no public deselect: clear its click info (fires onDeselected) when the store allows it.
    const store = (this.chart as unknown as { getChartStore?: () => { setClickOverlayInfo?: (...a: unknown[]) => void } }).getChartStore?.();
    try {
      store?.setClickOverlayInfo?.(
        { paneId: '', overlay: null, figureType: 'none', figureIndex: -1, figure: null },
        () => {},
        (o: Overlay) => o.onDeselected?.({ chart: this.chart, overlay: o } as Parameters<NonNullable<Overlay['onDeselected']>>[0]),
      );
    } catch { /* internal API changed: our own state below still deselects */ }
    if (this.selectedId === id) this.select(null);
  }

  /** Changes the selected drawing's style (merged with its current style); saved like any drawing edit. */
  setSelectedStyle(patch: Partial<DrawingLineStyle> | Partial<TextStyle>): void {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.locked || sel.kind === 'position') return;
    const o = this.userOverlays().find((x) => x.id === sel.id);
    const ownStyle = sel.kind === 'text' ? readText(o?.styles) !== null : readLine(o?.styles) !== null;
    const keys = Object.keys(patch);
    if (!ownStyle && keys.length === 1 && keys[0] === 'color' && typeof patch.color === 'string') {
      // A drawing without a style of its own gets only a color: its width / dash (font size) keep following the
      // default drawing style.
      this.chart.overrideOverlay({ id: sel.id, styles: colorToOverlay(patch.color, this.resolveColor) });
      this.emitChange();
      this.emitSelection();
      return;
    }
    const styles = sel.kind === 'text'
      ? textToOverlay({ ...sel.style, ...(patch as Partial<TextStyle>) }, this.resolveColor)
      : lineToOverlay({ ...sel.style, ...(patch as Partial<DrawingLineStyle>) }, this.resolveColor);
    // A hex replacing a palette reference: drop the reference (KLineChart merges styles; null replaces the key).
    const prev = o?.styles as Record<string, unknown> | null | undefined;
    if (prev?.[COLOR_REF_KEY] != null && !(COLOR_REF_KEY in styles)) (styles as Record<string, unknown>)[COLOR_REF_KEY] = null;
    // The style is now its own: the color-only marker goes.
    if (prev?.[COLOR_ONLY_KEY] != null) (styles as Record<string, unknown>)[COLOR_ONLY_KEY] = null;
    // Label options are re-sent with the style (never lost, whatever KLineChart's style merging does).
    if (sel.kind === 'line' && sel.label) (styles as Record<string, unknown>)[LABEL_STYLE_KEY] = { ...sel.label };
    if (sel.kind === 'line' && sel.extend) (styles as Record<string, unknown>)[EXTEND_STYLE_KEY] = { ...sel.extend };
    if (sel.kind === 'line' && sel.fill !== undefined) (styles as Record<string, unknown>)[FILL_STYLE_KEY] = sel.fill;
    this.chart.overrideOverlay({ id: sel.id, styles });
    this.emitChange();
    this.emitSelection();
  }

  /**
   * "Reset to default" of the selected drawing's color, saved like any drawing edit: a drawing with only a color of its
   * own drops it and follows the default drawing style again; one with its own width / dash keeps them and takes the
   * default color (see storedDefaultDrawing).
   */
  resetSelectedColor(): void {
    const sel = this.getSelectedDrawing();
    if (!sel || sel.locked || sel.kind === 'position') return;
    const o = this.userOverlays().find((x) => x.id === sel.id);
    const ownStyle = sel.kind === 'text' ? readText(o?.styles) !== null : readLine(o?.styles) !== null;
    if (ownStyle) {
      this.setSelectedStyle({ color: this.storedDefaultDrawing().color });
      return;
    }
    // Null drops the keys (KLineChart merges styles): the chart's overlay defaults apply again.
    const cleared = { line: null, text: null, polygon: null, [COLOR_ONLY_KEY]: null, [COLOR_REF_KEY]: null };
    this.chart.overrideOverlay({ id: sel.id, styles: cleared as unknown as DeepPartial<OverlayStyle> });
    this.emitChange();
    this.emitSelection();
  }

  /** Color new drawings start with (a palette reference; undefined or invalid → they follow the default drawing style). */
  private newDrawingColor: string | undefined;

  /** Sets the color new drawings start with: the last swatch picked (layout `drawingColor`); undefined resets it. */
  setNewDrawingColor(c: string | undefined): void {
    this.newDrawingColor = isDrawingColorToken(c) ? c : undefined;
  }

  /** The rest of the style new drawings start with (layout `drawingDefaults`); undefined = none set. */
  private newDrawingDefaults: DrawingDefaults | undefined;

  /** Sets the width / dash, font size and toggles new drawings start with: the last ones set in a style bar. */
  setNewDrawingDefaults(d: DrawingDefaults | undefined): void {
    this.newDrawingDefaults = d;
  }

  /**
   * Own styles of a new drawing of `tool`, from the sticky choices (none for positions):
   * - a line drawing with a sticky width or dash gets a full line style (the sticky color, else the default drawing
   *   color as stored); with only a sticky color, just that color (DrawingStyles.color), so its width / dash keep
   *   following the default drawing style; likewise the font size of text;
   * - its tool's toggles: a rectangle's fill, a channel's extend, a price / horizontal line's labels (per tool).
   */
  private newDrawingStyles(tool: string): DeepPartial<OverlayStyle> | undefined {
    if (isPositionTool(tool)) return undefined;
    const color = this.newDrawingColor;
    const d = this.newDrawingDefaults ?? {};
    let styles: Record<string, unknown> = {};
    if (tool === TEXT_TOOL ? d.textSize !== undefined : d.size !== undefined || d.style !== undefined) {
      const base = this.storedDefaultDrawing();
      const own = color ?? base.color;
      styles = (tool === TEXT_TOOL
        ? textToOverlay({ color: own, size: d.textSize! }, this.resolveColor)
        : lineToOverlay({ color: own, size: d.size ?? base.size, style: d.style ?? base.style }, this.resolveColor)) as Record<string, unknown>;
    } else if (color) {
      styles = colorToOverlay(color, this.resolveColor) as Record<string, unknown>;
    }
    if (FILL_DEFAULTS[tool] !== undefined && d.fill !== undefined) styles[FILL_STYLE_KEY] = d.fill;
    if (EXTEND_DEFAULTS[tool] && d.extend) styles[EXTEND_STYLE_KEY] = { ...d.extend };
    const label = (d.labels as Record<string, LabelOptions | undefined> | undefined)?.[tool];
    if (label) styles[LABEL_STYLE_KEY] = { ...label };
    return Object.keys(styles).length > 0 ? styles as DeepPartial<OverlayStyle> : undefined;
  }

  private emitChange(): void {
    if (this.silent > 0 || this.destroyed) return;
    this.recordHistory();
    for (const cb of this.changeListeners) cb();
  }

  // ── undo / redo (⌘Z / ⌘⇧Z) ──
  // Snapshots of the serialized drawings: every user edit (each onDrawingsChange) pushes the state before it. Restoring
  // drawings (a load, a symbol switch, a reload) starts a new history.

  /** Drawings as of the last recorded change (or restore): the state an edit is undone to. */
  private historyBase: DrawingState[] = [];
  private undoStack: DrawingState[][] = [];
  private redoStack: DrawingState[][] = [];

  private resetHistory(): void {
    this.historyBase = this.serializeDrawings();
    this.undoStack = [];
    this.redoStack = [];
  }

  private recordHistory(): void {
    const now = this.serializeDrawings();
    if (JSON.stringify(now) === JSON.stringify(this.historyBase)) return;
    this.undoStack.push(this.historyBase);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.historyBase = now;
  }

  /** Whether undo() has a drawing edit to undo. */
  canUndo(): boolean {
    return this.undoStack.length > 0 && this.pendingRestore === null;
  }

  /** Whether redo() has an undone edit to redo. */
  canRedo(): boolean {
    return this.redoStack.length > 0 && this.pendingRestore === null;
  }

  /**
   * Undoes the last drawing edit (saved like any edit: one onDrawingsChange). A drawing being placed is canceled
   * instead. Returns false when there is nothing to undo.
   */
  undo(): boolean {
    if (this.drawing) {
      this.cancelDrawing();
      return true;
    }
    if (!this.canUndo()) return false;
    this.redoStack.push(this.historyBase);
    this.applyHistory(this.undoStack.pop()!);
    return true;
  }

  /** Redoes the last undone drawing edit; false when there is none. */
  redo(): boolean {
    if (!this.canRedo()) return false;
    this.cancelDrawing();
    this.undoStack.push(this.historyBase);
    this.applyHistory(this.redoStack.pop()!);
    return true;
  }

  private applyHistory(drawings: DrawingState[]): void {
    const undo = this.undoStack;
    const redo = this.redoStack;
    this.clearMeasure();
    this.restoreDrawings(drawings, this.dataSymbol ?? undefined);
    this.undoStack = undo;
    this.redoStack = redo;
    if (this.destroyed) return;
    for (const cb of this.changeListeners) cb();
  }

  private withSilence(fn: () => void): void {
    this.silent++;
    try { fn(); } finally { this.silent--; }
  }

  private userOverlays(): Overlay[] {
    return this.chart.getOverlays().filter((o) => o.groupId !== MARKERS && o.groupId !== EVENTS && o.groupId !== MEASURE && !this.removing.has(o.id));
  }

  /**
   * Starts placing a drawing interactively. New drawings use the magnet mode; they are locked on draw end
   * when "lock all" is on (locking earlier would block the drawing clicks). `onEnd` fires once it is complete.
   */
  startDrawing(tool: DrawingTool, opts?: { text?: string; onEnd?: () => void }): void {
    this.cancelDrawing();
    this.clearMeasure();
    const create: OverlayCreate = { name: tool, mode: this.strongMagnet ? 'strong_magnet' : this.baseMode(), ...this.handlers };
    if (opts?.text !== undefined) create.extendData = opts.text;
    const styles = this.newDrawingStyles(tool);
    if (styles) create.styles = styles;
    const id = this.chart.createOverlay(create);
    if (typeof id === 'string') {
      this.drawing = opts?.onEnd ? { id, onEnd: opts.onEnd } : { id };
      if (this.strongMagnet) this.strongIds.add(id);
    }
  }

  /** Abandons the drawing being placed (if any); its onEnd fires. Finished drawings are untouched. */
  cancelDrawing(): void {
    const d = this.drawing;
    if (!d) return;
    this.endDrawing();
    this.withSilence(() => this.chart.removeOverlay({ id: d.id }));
  }

  /** Forgets the in-progress drawing and tells its starter that the tool is done. */
  private endDrawing(): void {
    const d = this.drawing;
    this.drawing = null;
    d?.onEnd?.();
  }

  /** Removes the selected drawing. Returns false when nothing (removable) is selected. */
  removeSelected(): boolean {
    const id = this.selectedId;
    if (!id) return false;
    const o = this.userOverlays().find((x) => x.id === id);
    if (!o || o.lock) {
      if (!o) this.selectedId = null;
      return false;
    }
    this.chart.removeOverlay({ id }); // onRemoved clears the selection and fires the change
    return true;
  }

  // ── copy / paste (in-app clipboard, see drawingClipboard; the system clipboard is never touched) ──

  /** The chart's bar duration (the timeframe's; a day before the first load). */
  private barMs(): number {
    return this.tf ? tfMs(this.tf) : 86_400_000;
  }

  /**
   * Copies the selected drawing (locked or not) to the in-app clipboard: its name, points, text, styles and options
   * (a daily-anchored drawing: its stored daily points and anchor); not its id or lock. False when nothing is selected.
   */
  copySelected(): boolean {
    const id = this.selectedId;
    if (!id || id === this.drawing?.id) return false;
    const o = this.userOverlays().find((x) => x.id === id);
    const shown = o ? completePoints(o) : null;
    if (!o || !shown) return false;
    const bars = this.chart.getDataList();
    const barMs = this.barMs();
    const idx = shown.map((p) => (bars.length > 0 ? barIndex(bars, p.timestamp, barMs) : Math.floor(p.timestamp / barMs)));
    const first = Math.min(...idx);
    const clip: DrawingClip = { name: o.name, points: shown.map((p) => ({ ...p })), barOffsets: idx.map((i) => i - first) };
    const anchor = this.anchors.get(o.id);
    if (anchor && (!anchor.display || samePoints(shown, anchor.display))) {
      clip.anchorTf = anchor.anchorTf;
      clip.points = (anchor.original ?? shown).map((p) => ({ ...p }));
    }
    if (typeof o.extendData === 'string') clip.text = o.extendData;
    const styles = normalizeOverlayStyles(o.name, o.styles);
    if (styles) clip.styles = structuredClone(styles);
    drawingClipboard.set(clip);
    return true;
  }

  /** True when pasteDrawing would paste: something was copied and this symbol's drawings and data are in. */
  canPaste(): boolean {
    return drawingClipboard.get() !== null && !this.destroyed && this.pendingRestore === null && this.dataSymbol !== null;
  }

  /**
   * Pastes the copied drawing as a new one on the current chart; it is selected and saved (one onDrawingsChange)
   * like a newly drawn drawing: locked only while "Lock all" is on. Placement:
   * - it keeps its times and prices, so it lands where it was copied from, also on another symbol or timeframe.
   *   A daily-anchored copy stays anchored on stock charts (09:30 New York of its dates on intraday charts);
   *   other points snap to the bar containing them on daily+ charts, which anchors them there like a new drawing;
   * - entirely outside the visible time range, it keeps its width in bars and is centered on the visible range,
   *   and only then, when its prices miss the visible bars' low…high, they are scaled (percentages kept) to center
   *   on that range (positions keep their prices if the scaled ones would not be valid);
   * - while an identical drawing is in the way (e.g. the original), it moves PASTE_OFFSET_BARS bars to the right
   *   (long / short positions: their own width plus PASTE_POSITION_GAP_BARS; horizontal drawings: up by
   *   PASTE_OFFSET_PRICE_SHARE of the visible price range), at most PASTE_CASCADE_MAX times, so pastes cascade.
   * The drawing being placed is canceled first. False (nothing pasted) with an empty clipboard or before the
   * current symbol's drawings and data are in.
   */
  pasteDrawing(): boolean {
    const clip = drawingClipboard.get();
    if (!clip || !this.canPaste()) return false;
    this.cancelDrawing();
    const bars = this.chart.getDataList();
    const barMs = this.barMs();
    const anchored = clip.anchorTf !== undefined && this.stockLike();
    const remap = anchored && this.mapsDailyAnchors();
    let base = clip.points.map((p) => ({ ...p, timestamp: remap ? toSessionOpen(p.timestamp) : p.timestamp }));
    if (!anchored && bars.length > 0 && this.tf !== null && !isIntraday(this.tf)) {
      base = base.map((p) => ({ ...p, timestamp: barTime(bars, barIndex(bars, p.timestamp, barMs), barMs) }));
    }
    const points = this.placePaste(clip, base);
    let id: string | null = null;
    // Silent like a restore: the creation and selection fire nothing; one explicit change below.
    this.withSilence(() => {
      const create: OverlayCreate = { name: clip.name, points, lock: this.lockAll, mode: this.baseMode(), ...this.handlers };
      if (clip.text !== undefined) create.extendData = clip.text;
      const styles = toOverlayStyles(sanitizeDrawingStyles(clip.styles), this.resolveColor);
      if (this.lockAll) create.styles = { ...styles, point: this.lockedPoint() };
      else if (styles) create.styles = styles;
      const created = this.chart.createOverlay(create);
      if (typeof created !== 'string') return;
      id = created;
      if (anchored && clip.anchorTf && samePoints(points, base)) {
        this.anchors.set(created, remap ? { anchorTf: clip.anchorTf, original: clip.points.map((p) => ({ ...p })), display: points } : { anchorTf: clip.anchorTf });
      } else {
        this.anchorAfterEdit(created);
      }
      this.selectOverlay(created);
    });
    if (id === null) return false;
    this.emitChange();
    if (isPositionTool(clip.name)) this.ensurePositionHistory();
    return true;
  }

  /** Where a paste of `clip` (at `base` on this chart) goes: see pasteDrawing. */
  private placePaste(clip: DrawingClip, base: Point[]): Point[] {
    const bars = this.chart.getDataList();
    const range = this.chart.getVisibleRange?.();
    if (bars.length === 0 || !range) return base;
    const barMs = this.barMs();
    const last = bars.length - 1;
    const from = Math.min(Math.max(range.from, 0), last);
    const to = Math.min(Math.max(range.to, from + 1), bars.length);
    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i < to; i++) {
      low = Math.min(low, bars[i]!.low);
      high = Math.max(high, bars[i]!.high);
    }
    const realFrom = range.realFrom;
    const realTo = Math.max(range.realTo, realFrom + 1);
    const times = base.map((p) => p.timestamp);
    // Horizontal lines span the whole width; price lines / horizontal rays extend to the right.
    const unbounded = clip.name === 'horizontalStraightLine';
    const toRight = unbounded || clip.name === 'priceLine' || clip.name === 'horizontalRayLine';
    const begin = unbounded ? -Infinity : Math.min(...times);
    const end = toRight ? Infinity : Math.max(...times);
    let points = base;
    if (end < barTime(bars, realFrom, barMs) || begin > barTime(bars, realTo - 1, barMs)) {
      const span = Math.max(...clip.barOffsets);
      const first = Math.round((realFrom + realTo - 1) / 2 - span / 2);
      points = points.map((p, i) => ({ ...p, timestamp: barTime(bars, first + (clip.barOffsets[i] ?? 0), barMs) }));
      points = this.scaleInto(clip.name, points, low, high);
    }
    return this.clearOfCopies(clip.name, points, low, high);
  }

  /** `points` scaled (percentages kept, rounded) to center on low…high when their prices miss that range. */
  private scaleInto(name: string, points: Point[], low: number, high: number): Point[] {
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!(low > 0) || !Number.isFinite(high) || !(min > 0) || (max >= low && min <= high)) return points;
    const factor = (low + high) / (min + max);
    const scaled = points.map((p) => ({ ...p, value: roundPrice(p.value * factor, this.pricePrecision) }));
    const side = sideOf(name);
    if (side) {
      const g = fromPositionPoints(scaled);
      if (!g || validatePrices(side, g) !== null) return points;
    }
    return scaled;
  }

  /** `points` moved (see pasteDrawing) until no drawing named `name` covers them exactly. */
  private clearOfCopies(name: string, points: Point[], low: number, high: number): Point[] {
    const others = this.userOverlays().filter((o) => o.name === name).map(completePoints).filter((p): p is Point[] => p !== null);
    const flat = HORIZONTAL_DRAWINGS.has(name);
    const covered = (pts: Point[]) => others.some((o) => (flat ? o[0]!.value === pts[0]!.value : samePoints(o, pts)));
    const bars = this.chart.getDataList();
    const barMs = this.barMs();
    const tick = 10 ** -this.pricePrecision;
    const step = Number.isFinite(high - low) ? Math.max(tick, roundPrice((high - low) * PASTE_OFFSET_PRICE_SHARE, this.pricePrecision)) : tick;
    const idx = points.map((p) => barIndex(bars, p.timestamp, barMs));
    const shift = isPositionTool(name) ? Math.max(...idx) - Math.min(...idx) + PASTE_POSITION_GAP_BARS : PASTE_OFFSET_BARS;
    let next = points;
    for (let n = 0; n < PASTE_CASCADE_MAX && covered(next); n++) {
      next = flat
        ? next.map((p) => ({ ...p, value: roundPrice(p.value + step, this.pricePrecision) }))
        : next.map((p) => ({ ...p, timestamp: barTime(bars, barIndex(bars, p.timestamp, barMs) + shift, barMs) }));
    }
    return next;
  }

  /** Selects overlay `id` as a click would (its handles show, the style bar opens). */
  private selectOverlay(id: string): void {
    const o = this.userOverlays().find((x) => x.id === id) as (Overlay & { paneId?: string }) | undefined;
    const store = (this.chart as unknown as { getChartStore?: () => { setClickOverlayInfo?: (...a: unknown[]) => void } }).getChartStore?.();
    try {
      store?.setClickOverlayInfo?.(
        { paneId: o?.paneId ?? CANDLE_PANE, overlay: o ?? null, figureType: 'none', figureIndex: -1, figure: null },
        (x: Overlay) => x.onSelected?.({ chart: this.chart, overlay: x } as Parameters<NonNullable<Overlay['onSelected']>>[0]),
        (x: Overlay) => x.onDeselected?.({ chart: this.chart, overlay: x } as Parameters<NonNullable<Overlay['onDeselected']>>[0]),
      );
    } catch { /* internal API changed: our own state below still selects */ }
    if (this.selectedId !== id) this.select(id);
  }

  /** Magnet (weak) snapping for drawings started from now on. */
  setMagnet(on: boolean): void {
    this.magnet = on;
  }

  /** Locks/unlocks every user drawing (markers stay locked); fires onDrawingsChange when anything changed. */
  setLockAll(locked: boolean): void {
    const was = this.lockAll;
    this.lockAll = locked;
    let changed = false;
    for (const o of this.userOverlays()) {
      if (o.id === this.drawing?.id) continue;
      if (this.applyLock(o.id)) changed = true;
    }
    // Drawings still waiting for data: their effective lock follows too (their own lock is kept).
    const pending = this.pendingRestore;
    if (pending) {
      pending.drawings = pending.drawings.map((d) => {
        const own = ChartAdapter.ownLock(d, was);
        if (d.lock !== (locked || own)) changed = true;
        const next: DrawingState = { ...d, lock: locked || own };
        if (own) next.locked = true;
        else delete next.locked;
        return next;
      });
    }
    this.emitLockState();
    if (changed) {
      this.emitChange();
      this.emitSelection();
    }
  }

  /**
   * Fired with the effective "lock all" state: on setLockAll and whenever drawings are restored or cleared
   * (see deriveLockAll). Returns an unsubscribe function.
   */
  onLockAllChange(cb: (locked: boolean) => void): () => void {
    this.lockListeners.add(cb);
    return () => { this.lockListeners.delete(cb); };
  }

  private emitLockState(): void {
    if (this.destroyed) return;
    for (const cb of this.lockListeners) cb(this.lockAll);
  }

  /**
   * "Lock all" of restored drawings: on when every drawing is locked and at least one is not locked on its own
   * (when every one has its own lock, "Lock all" adds nothing and turning it off would unlock nothing).
   */
  private deriveLockAll(drawings: DrawingState[]): void {
    this.lockAll = drawings.length > 0 && drawings.every((d) => d.lock) && drawings.some((d) => d.locked !== true);
    this.emitLockState();
  }

  /**
   * A restored drawing's own lock: its `locked` flag. Drawings saved before the flag existed keep, as their own,
   * a lock that "Lock all" does not explain (no drawing comes back less locked than it was saved).
   */
  private static ownLock(d: DrawingState, lockAll: boolean): boolean {
    return d.locked ?? (d.lock && !lockAll);
  }

  serializeDrawings(): DrawingState[] {
    if (this.pendingRestore) return this.pendingRestore.drawings.map(sanitizeDrawing);
    const out: DrawingState[] = [];
    for (const o of this.userOverlays()) {
      const points = completePoints(o); // skips an overlay that is still being drawn
      if (!points || o.id === this.drawing?.id) continue;
      const d: DrawingState = { name: o.name, points, lock: o.lock };
      if (this.ownLocks.has(o.id)) d.locked = true;
      const anchor = this.anchors.get(o.id);
      if (anchor?.display && anchor.original) {
        // Shown remapped: unmoved → the stored daily points; moved here → plain intraday points.
        if (samePoints(points, anchor.display)) {
          d.points = anchor.original;
          d.anchorTf = anchor.anchorTf;
        }
      } else if (anchor) {
        d.anchorTf = anchor.anchorTf;
      }
      if (typeof o.extendData === 'string') d.text = o.extendData;
      const styles = normalizeOverlayStyles(o.name, o.styles);
      if (styles) d.styles = styles;
      out.push(d);
    }
    return out;
  }

  /**
   * Replaces all user drawings. Does not fire onDrawingsChange. Existing drawings (and any in-progress one) are
   * removed at once; the new ones are created once data has arrived — for `symbol` when given (so drawings of a
   * new symbol never land on the previous symbol's data), else for the current load. Queued until then.
   * The "lock all" state is re-derived from the restored drawings, and the undo history starts over.
   */
  restoreDrawings(stored: DrawingState[], symbol?: string): void {
    // A drawing without points (older versions could store one) would put the chart into drawing mode: skipped.
    const drawings = stored.filter((d) => Array.isArray(d.points) && d.points.length > 0);
    this.endDrawing();
    this.withSilence(() => this.removeUserOverlays());
    this.pendingRestore = null;
    this.deriveLockAll(drawings);
    const ready = symbol === undefined ? this.dataSymbol !== null : this.dataSymbol === symbol;
    if (drawings.length > 0 && !ready) {
      this.pendingRestore = symbol === undefined ? { drawings } : { drawings, symbol };
    } else if (drawings.length > 0) {
      this.createDrawings(drawings);
      this.ensurePositionHistory();
    }
    this.resetHistory();
  }

  private createDrawings(drawings: DrawingState[]): void {
    this.withSilence(() => {
      const remap = this.mapsDailyAnchors();
      for (const d of drawings) {
        const display = d.anchorTf && remap ? d.points.map((p) => ({ ...p, timestamp: toSessionOpen(p.timestamp) })) : d.points;
        const own = ChartAdapter.ownLock(d, this.lockAll);
        const lock = this.lockAll || own;
        const create: OverlayCreate = { name: d.name, points: display, lock, ...this.handlers };
        if (d.text !== undefined) create.extendData = d.text;
        const styles = toOverlayStyles(sanitizeDrawingStyles(d.styles), this.resolveColor);
        if (lock) create.styles = { ...styles, point: this.lockedPoint() };
        else if (styles) create.styles = styles;
        const id = this.chart.createOverlay(create);
        if (typeof id === 'string' && own) this.ownLocks.add(id);
        if (typeof id === 'string' && d.anchorTf) {
          this.anchors.set(id, display === d.points ? { anchorTf: d.anchorTf } : { anchorTf: d.anchorTf, original: d.points, display });
        }
      }
    });
  }

  private onDataReady(): void {
    this.dataSymbol = this.loadSymbol;
    this.continueRange();
    this.renderEvents(); // events handed over before the first page arrived have bars to sit on now
    const pending = this.pendingRestore;
    if (!pending || (pending.symbol !== undefined && pending.symbol !== this.dataSymbol)) return;
    this.pendingRestore = null;
    this.createDrawings(pending.drawings);
    this.ensurePositionHistory();
    this.resetHistory();
  }

  /** Number of saved user drawings and how many of them are locked (own lock or "Lock all"). */
  drawingCount(): { total: number; locked: number } {
    const drawings = this.serializeDrawings();
    return { total: drawings.length, locked: drawings.filter((d) => d.lock).length };
  }

  /**
   * Removes every user drawing (and any in-progress one). With `keepLocked`, locked drawings (own lock or
   * "Lock all") stay. Fires onDrawingsChange once when anything was removed.
   */
  clearDrawings(opts?: { keepLocked?: boolean }): void {
    if (opts?.keepLocked) {
      this.endDrawing();
      let removed = false;
      const pending = this.pendingRestore;
      if (pending) {
        const kept = pending.drawings.filter((d) => d.lock);
        removed = kept.length !== pending.drawings.length;
        pending.drawings = kept;
        if (kept.length === 0) this.pendingRestore = null;
      }
      const doomed = this.userOverlays().filter((o) => !o.lock);
      this.withSilence(() => {
        for (const o of doomed) this.chart.removeOverlay({ id: o.id });
      });
      if (doomed.length > 0) removed = true;
      if (this.drawingCount().total === 0) this.deriveLockAll([]);
      if (removed) this.emitChange();
      return;
    }
    const had = this.userOverlays().length > 0 || this.pendingRestore !== null;
    this.endDrawing();
    this.pendingRestore = null;
    this.deriveLockAll([]);
    this.withSilence(() => this.removeUserOverlays());
    if (had) this.emitChange();
  }

  private removeUserOverlays(): void {
    for (const o of this.userOverlays()) this.chart.removeOverlay({ id: o.id });
    this.anchors.clear();
    this.ownLocks.clear();
  }

  /** Fired on draw end, move end and removal of user drawings. Returns an unsubscribe function. */
  onDrawingsChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => { this.changeListeners.delete(cb); };
  }

  // ── Shift measure ─────────────────────────────────────────────────────────
  // With no drawing tool active, a Shift press on the candle pane starts a measurement (an ephemeral overlay, never a
  // drawing): dragging sets its end and the release finishes it; a Shift-click without dragging lets the end follow
  // the mouse until the next click. The press never reaches KLineChart, so the chart does not pan. A finished
  // measurement stays until the next press without Shift, the next Shift measure, Escape (clearMeasure), a new drawing
  // tool or a new load. Points snap like drawings (magnet: weak, ⌘ / Ctrl held: strong).

  private measure: { id: string; start: MeasurePoint; end: MeasurePoint; phase: MeasurePhase; downAt: { x: number; y: number } | null } | null = null;
  private readonly measureListeners = new Set<(m: Measurement | null) => void>();
  private measureTracking = false;
  /** The latest mouse move not yet applied, and its animation frame (moves update the measure once per frame). */
  private pendingMove: MouseEvent | null = null;
  private moveFrame: number | null = null;

  /**
   * The ends of the measurement with their bar indexes recomputed from their times: the times are what is kept, so
   * older bars loaded in front (which shift every index) never stale the bar count, volume or label.
   */
  private measureEnds(m: { start: MeasurePoint; end: MeasurePoint }): { start: MeasurePoint; end: MeasurePoint } {
    const bars = this.chart.getDataList();
    if (bars.length === 0) return { start: m.start, end: m.end };
    const at = (p: MeasurePoint): MeasurePoint => ({ ...p, index: barIndex(bars, p.timestamp, this.barMs()) });
    return { start: at(m.start), end: at(m.end) };
  }

  /** The current measurement, or null. */
  getMeasurement(): Measurement | null {
    const m = this.measure;
    if (!m) return null;
    const { start, end } = this.measureEnds(m);
    const stats = measureStats(start, end, this.chart.getDataList());
    return { phase: m.phase, start, end, stats, lines: measureLines(stats, this.pricePrecision) };
  }

  /** Fired when a measurement is finished (with it) or cleared (null); not on every move. Returns an unsubscribe. */
  onMeasureChange(cb: (m: Measurement | null) => void): () => void {
    this.measureListeners.add(cb);
    return () => { this.measureListeners.delete(cb); };
  }

  private emitMeasure(): void {
    if (this.destroyed) return;
    const m = this.getMeasurement();
    for (const cb of this.measureListeners) cb(m);
  }

  /** Bar `index` (extrapolated outside the data) at `value`. Needs bars. */
  private measurePoint(p: { index: number; value: number }): MeasurePoint {
    return { index: p.index, timestamp: barTime(this.chart.getDataList(), p.index, this.barMs()), value: p.value };
  }

  private measureView(ends: { start: MeasurePoint; end: MeasurePoint }): MeasureView {
    const { start, end } = this.measureEnds(ends);
    const stats = measureStats(start, end, this.chart.getDataList());
    const a = resolveAppearance(this.theme, this.appearance);
    return {
      lines: measureLines(stats, this.pricePrecision),
      colors: measureColors(stats.up, { up: a.upColor, down: a.downColor, bg: themeTokens(this.theme).bg }),
      font: CHART_FONT,
    };
  }

  /**
   * Starts a measurement at bar `index` and price `value` (any previous one is replaced); its end follows
   * updateMeasure until finishMeasure. False (nothing shown) without bars.
   */
  startMeasure(p: { index: number; value: number }): boolean {
    if (this.chart.getDataList().length === 0) return false;
    this.removeMeasure();
    const start = this.measurePoint(p);
    const id = this.chart.createOverlay({
      name: MEASURE_OVERLAY, groupId: MEASURE, lock: true, mode: 'normal',
      points: [{ timestamp: start.timestamp, value: start.value }, { timestamp: start.timestamp, value: start.value }],
      extendData: this.measureView({ start, end: start }),
    });
    if (typeof id !== 'string') return false;
    this.measure = { id, start, end: start, phase: 'dragging', downAt: null };
    return true;
  }

  /** Moves the end of the measurement being made (a finished one stays). */
  updateMeasure(p: { index: number; value: number }): void {
    const m = this.measure;
    if (!m || m.phase === 'done' || this.chart.getDataList().length === 0) return;
    m.end = this.measurePoint(p);
    this.chart.overrideOverlay({
      id: m.id,
      points: [{ timestamp: m.start.timestamp, value: m.start.value }, { timestamp: m.end.timestamp, value: m.end.value }],
      extendData: this.measureView(m),
    });
  }

  /** Finishes the measurement (at `p` when given): it stays shown until cleared. */
  finishMeasure(p?: { index: number; value: number }): void {
    const m = this.measure;
    if (!m || m.phase === 'done') return;
    if (p) this.updateMeasure(p);
    m.phase = 'done';
    this.stopMeasureTracking();
    this.emitMeasure();
  }

  /** Removes the measurement (Escape, a press without Shift); nothing happens without one. */
  clearMeasure(): void {
    if (this.removeMeasure()) this.emitMeasure();
  }

  private removeMeasure(): boolean {
    this.stopMeasureTracking();
    const m = this.measure;
    if (!m) return false;
    this.measure = null;
    this.chart.removeOverlay({ id: m.id });
    return true;
  }

  /** Recolors the measurement (theme / candle colors changed). */
  private refreshMeasure(): void {
    const m = this.measure;
    if (m) this.chart.overrideOverlay({ id: m.id, extendData: this.measureView(m) });
  }

  /** True while the mouse is over a drawing (a Shift press there drags it, kept horizontal). */
  private hoveringDrawing(): boolean {
    const store = (this.chart as unknown as { getChartStore?: () => { getHoverOverlayInfo?: () => { overlay?: { groupId?: string } | null } } }).getChartStore?.();
    try {
      const o = store?.getHoverOverlayInfo?.()?.overlay;
      return o != null && o.groupId !== MEASURE && o.groupId !== MARKERS && o.groupId !== EVENTS;
    } catch {
      return false;
    }
  }

  /**
   * The measure point under the mouse: its bar and price (snapped like drawings). Null outside the candle pane's plot
   * area (indicator panes, axes) unless `clamp`, which moves the point to the nearest edge (drags leaving the pane).
   */
  private measurePointAt(e: MouseEvent, clamp = false): { index: number; value: number } | null {
    const bars = this.chart.getDataList();
    const dom = this.chart.getDom?.(CANDLE_PANE, 'main');
    if (!dom || bars.length === 0) return null;
    const r = dom.getBoundingClientRect();
    let x = e.clientX - r.left;
    let y = e.clientY - r.top;
    if (clamp) {
      x = Math.min(r.width, Math.max(0, x));
      y = Math.min(r.height, Math.max(0, y));
    } else if (x < 0 || y < 0 || x > r.width || y > r.height) {
      return null;
    }
    const pt = (this.chart.convertFromPixel([{ x, y }], { paneId: CANDLE_PANE }) as Array<Partial<KPoint>>)[0];
    if (typeof pt?.dataIndex !== 'number' || typeof pt.value !== 'number' || !Number.isFinite(pt.value)) return null;
    const mode: MeasureSnap = this.strongMagnet ? 'strong_magnet' : this.magnet ? 'weak_magnet' : 'normal';
    const yOf = (v: number) => (this.chart.convertToPixel({ value: v }, { paneId: CANDLE_PANE }) as Partial<Coordinate>).y ?? y;
    return { index: pt.dataIndex, value: snapValue(pt.value, bars[pt.dataIndex] ?? null, mode, yOf) };
  }

  /** A left press on the chart (capture phase, before KLineChart): true when the measure took it. */
  private measurePress(e: MouseEvent): boolean {
    const m = this.measure;
    if (m && m.phase !== 'done') {
      // A click ends a Shift-click measurement (a second press while dragging cannot happen, but is swallowed too).
      e.stopPropagation();
      e.preventDefault();
      if (m.phase === 'placing') this.finishMeasure(this.measurePointAt(e, true) ?? undefined);
      return true;
    }
    if (e.shiftKey && !this.drawing && !this.hoveringDrawing()) {
      const p = this.measurePointAt(e);
      if (p && this.startMeasure(p)) {
        e.stopPropagation();
        e.preventDefault();
        this.measure!.downAt = { x: e.clientX, y: e.clientY };
        this.startMeasureTracking();
        // What KLineChart's click would have done: the selected drawing is deselected and a focused field loses focus.
        this.deselect();
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && !this.el.contains(active)) active.blur();
        return true;
      }
    }
    this.clearMeasure();
    return false;
  }

  private readonly onMeasureMove = (e: MouseEvent): void => {
    this.pendingMove = e;
    if (this.moveFrame === null) this.moveFrame = requestAnimationFrame(this.applyMove);
  };

  private readonly applyMove = (): void => {
    this.moveFrame = null;
    const e = this.pendingMove;
    this.pendingMove = null;
    const p = e && this.measure && this.measure.phase !== 'done' ? this.measurePointAt(e, true) : null;
    if (p) this.updateMeasure(p);
  };

  /** Drops the move waiting for its frame (a release or a click sets the end itself). */
  private dropPendingMove(): void {
    this.pendingMove = null;
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
  }

  private readonly onMeasureUp = (e: MouseEvent): void => {
    this.dropPendingMove();
    const m = this.measure;
    if (!m || m.phase !== 'dragging' || e.button !== 0) return;
    const d = m.downAt;
    const moved = !d || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) >= MEASURE_CLICK_PX;
    if (moved) this.finishMeasure(this.measurePointAt(e, true) ?? undefined);
    else m.phase = 'placing';
  };

  /** A press outside the chart while the end follows the mouse finishes the measurement where it is. */
  private readonly onMeasureOutsidePress = (e: MouseEvent): void => {
    if (this.measure?.phase === 'placing' && !(e.target instanceof Node && this.el.contains(e.target))) this.finishMeasure();
  };

  private readonly onMeasureBlur = (): void => { this.finishMeasure(); };

  private startMeasureTracking(): void {
    if (this.measureTracking) return;
    this.measureTracking = true;
    document.addEventListener('mousemove', this.onMeasureMove, true);
    document.addEventListener('mouseup', this.onMeasureUp, true);
    document.addEventListener('mousedown', this.onMeasureOutsidePress, true);
    window.addEventListener('blur', this.onMeasureBlur);
  }

  private stopMeasureTracking(): void {
    this.dropPendingMove();
    if (!this.measureTracking) return;
    this.measureTracking = false;
    document.removeEventListener('mousemove', this.onMeasureMove, true);
    document.removeEventListener('mouseup', this.onMeasureUp, true);
    document.removeEventListener('mousedown', this.onMeasureOutsidePress, true);
    window.removeEventListener('blur', this.onMeasureBlur);
  }

  // ── date ranges ───────────────────────────────────────────────────────────

  /**
   * The date range shown with showRange: fitted once the current load's bars cover it (older pages are requested
   * as needed), then re-fitted on resize and when a new bar arrives (`lastTs`: the latest bar it was fitted to) until
   * the user zooms or scrolls, or the data reloads.
   */
  private range: { preset: RangePreset; calendar: RangeCalendar; fitted: boolean; lastTs: number } | null = null;
  /** Older pages requested for ranges since the last load(), at most MAX_HISTORY_PAGES whatever is picked. */
  private rangePages = 0;
  private readonly rangeListeners = new Set<() => void>();
  private readonly rangeShownListeners = new Set<(shown: ShownRange) => void>();
  /** The chart timezone of the current load (range labels read in it). */
  private rangeTimeZone = 'UTC';
  /**
   * > 0 while the adapter itself moves the view. Defensive: KLineChart 10.0.x's setBarSpace / setOffsetRightDistance
   * emit neither onZoom nor onScroll, but a version that did must not cancel the range being fitted.
   */
  private fitting = 0;

  /**
   * Shows date range `preset` (in `calendar`'s days and sessions) on the current data, ending at the latest bar:
   * the chart's interval must already be the preset's (see rangeTimeframe). Before the data is in, it is fitted as
   * soon as it is; a load() or clear() drops it.
   */
  showRange(preset: RangePreset, calendar: RangeCalendar): void {
    this.range = { preset, calendar, fitted: false, lastTs: Number.NaN };
    if (this.dataSymbol !== null && this.dataSymbol === this.loadSymbol) this.continueRange();
  }

  /** Called when the user zooms or scrolls away from a range shown with showRange (it is then dropped). */
  onRangeCanceled(cb: () => void): () => void {
    this.rangeListeners.add(cb);
    return () => this.rangeListeners.delete(cb);
  }

  /** Called each time a range shown with showRange is fitted (again on resize): the bars it shows. */
  onRangeShown(cb: (shown: ShownRange) => void): () => void {
    this.rangeShownListeners.add(cb);
    return () => this.rangeShownListeners.delete(cb);
  }

  /** Width (px) of the price pane's plot area, where bars are laid out (0 before the first layout). */
  plotWidth(): number {
    return this.chart.getSize?.(CANDLE_PANE, 'main')?.width ?? 0;
  }

  /**
   * The user zoomed or scrolled: the range is dropped. A touch fling (KLineChart 10.0.x animates one after a quick
   * swipe; mouse drags have none) still running when a range is picked keeps scrolling, rewriting the scroll position
   * the fit set, so its next frame both moves the view and deselects the range: telling such frames apart would take
   * KLineChart's private event state, and the deselection matches what the chart then shows.
   */
  private readonly onUserView = (): void => {
    if (this.fitting > 0 || this.range === null) return;
    this.range = null;
    for (const cb of [...this.rangeListeners]) cb();
  };

  /**
   * Requests the next older page while the pending range needs one, else fits it (page arrivals call this again).
   * A fitted range is fitted again when a newer bar arrives, so it keeps ending at the latest bar (1D moves on to a
   * new session) and its span stays current.
   */
  private continueRange(): void {
    const r = this.range;
    if (!r || this.destroyed || this.tf === null) return;
    const data = this.chart.getDataList();
    const first = data[0];
    const latest = data.at(-1);
    if (!first || !latest) return;
    if (r.fitted) {
      if (latest.timestamp !== r.lastTs) this.fitRange(r);
      return;
    }
    const start = rangeStart(r.preset, data.map((d) => d.timestamp), this.tf, r.calendar);
    const deeper = start < first.timestamp && first.timestamp > latest.timestamp - rangeLookbackMs(r.preset);
    if (deeper && !this.historyBlocked && this.rangePages < MAX_HISTORY_PAGES && this.hasOlderData()) {
      const store = this.dataStore();
      const load = store?._processDataLoad;
      if (typeof load === 'function') {
        if (store?._loading === true) return; // a page is on its way: its arrival calls this again
        this.rangePages++;
        try {
          load.call(store, 'forward');
          return;
        } catch { /* internal API changed: fit what is loaded */ }
      }
    }
    this.fitRange(r);
  }

  /** Bar width and scroll that show `r` from its first bar to the latest one (plus the usual right margin). */
  private fitRange(r: NonNullable<ChartAdapter['range']>): void {
    if (this.tf === null) return;
    const times = this.chart.getDataList().map((d) => d.timestamp);
    const count = visibleBarCount(times, rangeStart(r.preset, times, this.tf, r.calendar));
    const width = this.plotWidth();
    const space = fitBarSpace(count, width, RANGE_RIGHT_MARGIN_PX);
    r.fitted = true;
    r.lastTs = times.at(-1) ?? Number.NaN;
    this.fitting++;
    try {
      this.chart.setBarSpace(space);
      this.chart.setOffsetRightDistance(RANGE_RIGHT_MARGIN_PX); // back to the latest bar, at the chart's default gap
    } finally {
      this.fitting--;
    }
    // Too many bars for the width (at the narrowest bars): the newest that fit are shown.
    const bars = barsShown(count, width, RANGE_RIGHT_MARGIN_PX, space);
    const first = times[times.length - bars];
    const last = times.at(-1);
    if (first === undefined || last === undefined) return;
    const shown: ShownRange = { preset: r.preset, first, last, bars, label: rangeLabel(first, last, this.tf, this.rangeTimeZone) };
    for (const cb of [...this.rangeShownListeners]) cb(shown);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  resize(): void {
    this.chart.resize();
    if (this.range?.fitted) this.fitRange(this.range);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.selectedId !== null && drawingContext.selectedId === this.selectedId) drawingContext.selectedId = null;
    this.el.removeEventListener('mousedown', this.onPressCapture, true);
    this.chart.unsubscribeAction?.('onZoom', this.onUserView);
    this.chart.unsubscribeAction?.('onScroll', this.onUserView);
    this.range = null;
    this.rangeListeners.clear();
    this.rangeShownListeners.clear();
    this.stopMeasureTracking();
    this.measure = null;
    this.measureListeners.clear();
    this.loader?.dispose();
    this.loader = null;
    this.changeListeners.clear();
    this.lockListeners.clear();
    this.selectionListeners.clear();
    this.priceEditListeners.clear();
    releasePositionContext(this.ownEndFor);
    dispose(this.el);
  }
}

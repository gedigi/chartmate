import {
  dispose, init,
  type Chart, type DeepPartial, type IndicatorCreate, type IndicatorDrawCallback, type IndicatorStyle, type KLineData, type Overlay, type OverlayCreate,
  type OverlayMode, type OverlayStyle, type Styles,
} from 'klinecharts';
import {
  isIntraday, isPositionTool, nyToUtc, resolvePositionDefaults, tfMs,
  type ChartType, type DrawingLineStyle, type DrawingState, type IndicatorState, type Marker, type PositionDefaults,
  type ThemedAppearance, type SessionMode, type SymbolInfo, type Timeframe,
} from '@chartmate/shared';
import {
  klineLine, lineToOverlay, normalizeOverlayStyles, readLine, readText, sanitizeDrawingStyles, textToOverlay, toOverlayStyles, TEXT_TOOL,
  type TextStyle,
} from './drawingStyles';
import {
  drawingConstraint, EXTEND_STYLE_KEY, extendOptions, flattenBase, LABEL_STYLE_KEY, labelOptions, registerDrawingTemplates, roundPrice, SHIFT_TOOLS,
  type ExtendOptions, type LabelOptions,
} from './drawingTemplates';
import {
  DEFAULT_WIDTH_BARS, defaultGeometry, endAfterBars, fromPositionPoints, nextBarTime, shiftByBars, sideOf,
  toPositionPoints, validatePrices, type OutcomeBar, type PositionMetrics, type PositionOutcome, type PositionSide,
} from './position';
import { positionContext, positionState, registerPositionOverlays } from './positionOverlay';
import { createDataLoader, type DataLoaderImpl, type LoaderEvents } from './dataLoader';
import { catalogEntry, defaultLineColor, effectiveLevels } from './indicators/catalog';
import { CUSTOM_INDICATORS, PRICE_PRECISION_INDICATORS } from './indicators/extensions';
import { levelsDraw, levelsRange } from './indicators/levels';
import { registerCustomIndicators } from './indicators/register';
import type { IndicatorExtendData } from './indicators/types';
import { toPeriod } from './periods';
import { MARKER_OVERLAY, markerStyles, registerMarkerOverlay } from './markers';
import { registerSessionShade, SESSION_SHADE, SHADE_INDICATORS } from './sessionShade';
import { textColoredLegends } from './barLegends';
import { solidBarFigures } from './solidBars';
import { axisTickLabels, countdownText, crosshairDate, hasCountdown } from './timeLabels';
import {
  candleStyles, chartStyles, DEFAULT_TEXT_SIZE, defaultIndicatorBars, indicatorLevelColor, overlayStyles, refreshThemeTokens, resolveAppearance, themeSoftTone, themeTokens,
  type ThemeName,
} from './theme';

export type DrawingTool =
  | 'segment' | 'rayLine' | 'straightLine' | 'horizontalStraightLine' | 'verticalStraightLine'
  | 'priceLine' | 'parallelChannel' | 'fibonacciLine' | 'simpleAnnotation' | 'longPosition' | 'shortPosition';

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

/**
 * Lock state of the selected drawing: `locked` is the effective lock ("Lock all drawings" or its own lock: read-only,
 * not removable), `ownLock` its own lock (the style bar's lock toggle), which outlives "Lock all" being turned off.
 */
interface SelectedLock { locked: boolean; ownLock: boolean }

/** Style of the selected drawing, as the floating style bar edits it. */
export type SelectedDrawing = SelectedLock & (
  | {
    id: string; kind: 'line'; style: DrawingLineStyle;
    /** Horizontal drawings only: their price and the symbol's price precision. */
    price?: { value: number; precision: number };
    /** Price / horizontal lines only: effective price-label options (price text on the line, label on the axis). */
    label?: LabelOptions;
    /** Parallel channels only: effective extend options (lines extended past the left / right end). */
    extend?: ExtendOptions;
  }
  | { id: string; kind: 'text'; style: TextStyle }
  | {
    id: string; kind: 'position'; side: PositionSide;
    entry: number; target: number; stop: number; precision: number;
    /** The derived numbers (R:R, % distances) and the outcome so far. */
    metrics: PositionMetrics; outcome: PositionOutcome;
  });

const INDICATOR_DASH = [4, 4];

export interface LoadParams {
  symbol: SymbolInfo; tf: Timeframe; session: SessionMode; pollMs: number;
  /** A basket with crypto constituents: its bars follow the UTC grid, so daily anchors are not remapped. */
  basketHasCrypto?: boolean;
}

const CANDLE_PANE = 'candle_pane';
/** KLineChart's double-click window and distance (Delay.ResetClick, ManhattanDistance.DoubleClick). */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 5;
const MARKERS = 'markers';
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
  return pts.length > 0 ? pts : null;
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
  private chartType: ChartType = 'candle';
  private tf: Timeframe | null = null;
  private loader: DataLoaderImpl | null = null;
  private markers: Marker[] = [];
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

  constructor(el: HTMLElement, opts: { theme: ThemeName }) {
    registerSessionShade();
    registerMarkerOverlay();
    registerDrawingTemplates();
    registerPositionOverlays();
    registerCustomIndicators();
    this.el = el;
    this.theme = opts.theme;
    refreshThemeTokens(opts.theme); // chart colors come from the CSS tokens (constants as fallback)
    this.updatePositionColors();
    positionContext.defaults = resolvePositionDefaults(undefined);
    positionContext.endFor = (start) => this.positionEnd(start);
    positionContext.minEnd = (start) => nextBarTime(this.chart.getDataList(), start, positionContext.barMs);
    positionContext.shiftEnd = (end, from, to) => shiftByBars(this.chart.getDataList(), end, from, to, positionContext.barMs);
    positionContext.historyComplete = () => !this.hasOlderData();
    const chart = init(el, { styles: this.styles() });
    if (!chart) throw new Error('Failed to initialize the chart');
    this.chart = chart;
    // Capture phase on the host: runs before KLineChart's own mousedown handler on its inner container.
    el.addEventListener('mousedown', this.onPressCapture, true);
  }

  private styles(): DeepPartial<Styles> {
    const base = chartStyles(this.theme);
    const countdown = this.tf !== null && this.assetClass !== null && hasCountdown(this.tf, this.assetClass);
    const candle = candleStyles(this.chartType, this.theme, this.appearance, countdown);
    return {
      ...base,
      candle: { ...base.candle, ...candle, priceMark: { ...base.candle?.priceMark, ...candle.priceMark } },
      // Default histogram bars follow the resolved candle colors (custom ones included).
      indicator: { ...base.indicator, bars: [{ style: 'fill', borderSize: 0, ...defaultIndicatorBars(this.theme, this.appearance) }] },
      // Unstyled drawings follow the appearance's default drawing style (theme accent when unset).
      overlay: overlayStyles(this.defaultDrawing()),
    };
  }

  private defaultDrawing(): DrawingLineStyle {
    return resolveAppearance(this.theme, this.appearance).drawing;
  }

  /** Position zones / labels: the candle up / down colors of the active theme, muted gray for neutral parts. */
  private updatePositionColors(): void {
    const a = resolveAppearance(this.theme, this.appearance);
    const t = themeTokens(this.theme);
    positionContext.colors = { up: a.upColor, down: a.downColor, neutral: t.muted, bg: t.bg };
  }

  // ── data ──────────────────────────────────────────────────────────────────

  load(p: LoadParams, events: LoaderEvents): void {
    const prevSymbol = this.loadSymbol;
    const prevMapping = this.mapsDailyAnchors();
    this.loader?.dispose(); // its pending results and polling become no-ops while the chart resets below
    this.dataSymbol = null;
    this.loadSymbol = p.symbol.id;
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
    this.setIndicatorContext({ assetClass: p.symbol.assetClass, intraday: isIntraday(p.tf), pricePrecision: p.symbol.pricePrecision });
    const timezone = timezoneFor(p.symbol, p.tf);
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
    this.chart.overrideXAxis({
      createTicks: ({ defaultTicks }) => {
        const labels = axisTickLabels(defaultTicks.map((t) => Number(t.value)), tf, timezone);
        return defaultTicks.map((t, i) => ({ ...t, text: labels[i]! }));
      },
    });
    this.chart.setStyles(this.styles());
  }

  /**
   * Stops loading/polling and blanks the chart (e.g. while the current symbol's info cannot be loaded), so
   * the previous symbol's data is neither shown nor polled any more. The next load() starts afresh.
   */
  clear(): void {
    this.loader?.dispose();
    this.loader = null;
    this.dataSymbol = null;
    this.loadSymbol = null;
    this.markers = [];
    this.renderMarkers();
    this.installEmptyLoader();
  }

  /** A loader that answers 'init' with no data: installing it resets KLineChart to an empty series. */
  private installEmptyLoader(): void {
    this.chart.setDataLoader({ getBars: ({ callback }) => callback([], { forward: false, backward: false }) });
  }

  // ── appearance ────────────────────────────────────────────────────────────

  setTheme(t: ThemeName): void {
    this.theme = t;
    refreshThemeTokens(t);
    this.updatePositionColors();
    this.chart.setStyles(this.styles());
    for (const o of this.chart.getOverlays({ groupId: MARKERS })) this.chart.overrideOverlay({ id: o.id, styles: markerStyles(t) });
    this.refreshLockedLook();
    // Indicator lines without a color override carry the palette of the theme they were written in: rewrite
    // them (width / style overrides kept; user colors are never touched).
    for (const i of this.chart.getIndicators()) {
      const o = this.overrides.get(i.id) ?? {};
      if (o.lineColors) continue;
      const styles = this.indicatorStyles(i.name, o, undefined, 'all-lines');
      if (styles?.lines) this.chart.overrideIndicator({ id: i.id, name: i.name, styles: { lines: styles.lines } });
    }
    this.refreshThemedBars();
  }

  /**
   * Indicators without a bar-color override follow the chart styles, except those whose override was removed
   * (their defaults were written explicitly): give them the current default bars (theme / candle colors).
   */
  private refreshThemedBars(): void {
    if (this.themedBars.size === 0) return;
    const d = this.chart.getStyles().indicator.bars[0]!;
    for (const i of this.chart.getIndicators()) {
      if (this.themedBars.has(i.id)) this.chart.overrideIndicator({ id: i.id, name: i.name, styles: { bars: [{ ...d, ...defaultIndicatorBars(this.theme, this.appearance) }] } });
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
    this.chart.setStyles(this.styles());
    this.refreshThemedBars();
    this.refreshLockedLook();
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
    // The selected position's outcome follows new bars (polling / backfill).
    if (this.selectedId && this.userOverlays().some((o) => o.id === this.selectedId && isPositionTool(o.name))) this.emitSelection();
    if (this.markers.length === 0) return;
    const key = JSON.stringify(this.markerOverlays().map((o) => [o.extendData, o.points?.[0]?.timestamp]));
    if (key !== this.markersKey) this.renderMarkers();
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
      // Forced writes (create / theme re-apply) cover every catalog line, so lines past a partial override array
      // still get the theme palette instead of KLineChart's defaults; plain updates write the overridden lines only.
      const overridden = Math.max(o.lineColors?.length ?? 0, o.lineWidths?.length ?? 0, o.lineStyles?.length ?? 0);
      const n = force && lineCount > 0 ? lineCount : hasLines && force !== 'all-lines' ? overridden : lineCount > 0 ? lineCount : defaults.length;
      styles.lines = Array.from({ length: n }, (_, i) => {
        const d = defaults[i % defaults.length]!;
        const style = o.lineStyles?.[i] ?? 'solid';
        const size = o.lineWidths?.[i] ?? 1;
        const line = klineLine(style, size, INDICATOR_DASH);
        return {
          ...d,
          color: o.lineColors?.[i] ?? d.color,
          size,
          ...line,
          dashedValue: style === 'solid' ? d.dashedValue : line.dashedValue,
        };
      });
    }
    if (o.barColors || reset?.barColors) {
      const d = this.chart.getStyles().indicator.bars[0]!;
      styles.bars = [o.barColors ? { ...d, upColor: o.barColors.up, downColor: o.barColors.down } : { ...d, ...defaultIndicatorBars(this.theme, this.appearance) }];
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
    // Histogram bars are always filled (MACD / AO outline rising bars by default): rising ones in the soft tone.
    const created = this.chart.getIndicators().find((i) => i.id === id);
    const figures = solidBarFigures(created?.figures, (c) => themeSoftTone(this.theme, c));
    // Bar values in the legend take the up / down TEXT tones (never the faint soft tone of a rising bar).
    const legends = created?.figures?.some((f) => f.type === 'bar') ? { createTooltipDataSource: this.barLegends } : {};
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
  private setIndicatorContext(ext: Required<IndicatorExtendData>): void {
    const cur = this.indicatorExt;
    if (cur.assetClass === ext.assetClass && cur.intraday === ext.intraday && cur.pricePrecision === ext.pricePrecision) return;
    this.indicatorExt = ext;
    for (const i of this.chart.getIndicators()) {
      if (SHADE_INDICATORS.has(i.name)) continue;
      const override: IndicatorCreate = { id: i.id, name: i.name, extendData: ext };
      // Bounded oscillators keep their fixed precision; price-unit ones follow the symbol.
      if (!BOUNDED_INDICATORS.has(i.name)) {
        const precision = indicatorPrecision(i.name, ext.pricePrecision);
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
    const d = this.defaultDrawing();
    if (o.name === TEXT_TOOL) {
      const style = readText(o.styles) ?? { color: d.color, size: DEFAULT_TEXT_SIZE };
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
    const style = readLine(o.styles) ?? { ...d };
    const sel: SelectedDrawing = { id: o.id, kind: 'line', style, ...this.lockOf(o) };
    const value = o.points[0]?.value;
    if (HORIZONTAL_DRAWINGS.has(o.name) && typeof value === 'number') sel.price = { value, precision: this.pricePrecision };
    const label = labelOptions(o.name, o.styles);
    if (label) sel.label = label;
    const extend = extendOptions(o.name, o.styles);
    if (extend) sel.extend = extend;
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
   * Handles of a locked drawing: hollow rings (the theme background inside, the default drawing color around) that
   * do not grow on hover, since they cannot be dragged.
   */
  private lockedPoint(): DeepPartial<OverlayStyle['point']> {
    const bg = themeTokens(this.theme).bg;
    const ring = this.defaultDrawing().color;
    return {
      color: bg, borderColor: ring, borderSize: 1.5, radius: 3.5,
      activeColor: bg, activeBorderColor: ring, activeBorderSize: 1.5, activeRadius: 3.5,
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
    const styles = sel.kind === 'text'
      ? textToOverlay({ ...sel.style, ...(patch as Partial<TextStyle>) })
      : lineToOverlay({ ...sel.style, ...(patch as Partial<DrawingLineStyle>) });
    // Label options are re-sent with the style (never lost, whatever KLineChart's style merging does).
    if (sel.kind === 'line' && sel.label) (styles as Record<string, unknown>)[LABEL_STYLE_KEY] = { ...sel.label };
    if (sel.kind === 'line' && sel.extend) (styles as Record<string, unknown>)[EXTEND_STYLE_KEY] = { ...sel.extend };
    this.chart.overrideOverlay({ id: sel.id, styles });
    this.emitChange();
    this.emitSelection();
  }

  private emitChange(): void {
    if (this.silent > 0 || this.destroyed) return;
    for (const cb of this.changeListeners) cb();
  }

  private withSilence(fn: () => void): void {
    this.silent++;
    try { fn(); } finally { this.silent--; }
  }

  private userOverlays(): Overlay[] {
    return this.chart.getOverlays().filter((o) => o.groupId !== MARKERS && !this.removing.has(o.id));
  }

  /**
   * Starts placing a drawing interactively. New drawings use the magnet mode; they are locked on draw end
   * when "lock all" is on (locking earlier would block the drawing clicks). `onEnd` fires once it is complete.
   */
  startDrawing(tool: DrawingTool, opts?: { text?: string; onEnd?: () => void }): void {
    this.cancelDrawing();
    const create: OverlayCreate = { name: tool, mode: this.strongMagnet ? 'strong_magnet' : this.baseMode(), ...this.handlers };
    if (opts?.text !== undefined) create.extendData = opts.text;
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
   * The "lock all" state is re-derived from the restored drawings.
   */
  restoreDrawings(drawings: DrawingState[], symbol?: string): void {
    this.endDrawing();
    this.withSilence(() => this.removeUserOverlays());
    this.pendingRestore = null;
    this.deriveLockAll(drawings);
    if (drawings.length === 0) return;
    const ready = symbol === undefined ? this.dataSymbol !== null : this.dataSymbol === symbol;
    if (!ready) {
      this.pendingRestore = symbol === undefined ? { drawings } : { drawings, symbol };
      return;
    }
    this.createDrawings(drawings);
    this.ensurePositionHistory();
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
        const styles = toOverlayStyles(sanitizeDrawingStyles(d.styles));
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
    const pending = this.pendingRestore;
    if (!pending || (pending.symbol !== undefined && pending.symbol !== this.dataSymbol)) return;
    this.pendingRestore = null;
    this.createDrawings(pending.drawings);
    this.ensurePositionHistory();
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

  // ── lifecycle ─────────────────────────────────────────────────────────────

  resize(): void {
    this.chart.resize();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.el.removeEventListener('mousedown', this.onPressCapture, true);
    this.loader?.dispose();
    this.loader = null;
    this.changeListeners.clear();
    this.lockListeners.clear();
    this.selectionListeners.clear();
    this.priceEditListeners.clear();
    dispose(this.el);
  }
}

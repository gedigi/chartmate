import {
  dispose, init,
  type Chart, type DeepPartial, type IndicatorCreate, type IndicatorStyle, type KLineData, type Overlay, type OverlayCreate,
  type OverlayMode, type Styles,
} from 'klinecharts';
import {
  isIntraday, tfMs,
  type ChartAppearance, type ChartType, type DrawingLineStyle, type DrawingState, type IndicatorState, type Marker,
  type SessionMode, type SymbolInfo, type Timeframe,
} from '@altv/shared';
import {
  lineToOverlay, normalizeOverlayStyles, readLine, readText, sanitizeDrawingStyles, textToOverlay, toOverlayStyles, TEXT_TOOL,
  type TextStyle,
} from './drawingStyles';
import { createDataLoader, type DataLoaderImpl, type LoaderEvents } from './dataLoader';
import { catalogEntry } from './indicators/catalog';
import { PRICE_PRECISION_INDICATORS } from './indicators/extensions';
import { registerCustomIndicators } from './indicators/register';
import type { IndicatorExtendData } from './indicators/types';
import { toPeriod } from './periods';
import { MARKER_OVERLAY, markerStyles, registerMarkerOverlay } from './markers';
import { registerSessionShade, SESSION_SHADE, SHADE_INDICATORS } from './sessionShade';
import { candleStyles, chartStyles, DEFAULT_TEXT_SIZE, overlayStyles, resolveAppearance, type ThemeName } from './theme';

export type DrawingTool =
  | 'segment' | 'rayLine' | 'straightLine' | 'horizontalStraightLine' | 'verticalStraightLine'
  | 'priceLine' | 'parallelStraightLine' | 'fibonacciLine' | 'simpleAnnotation';

export interface IndicatorSpec extends Pick<IndicatorState, 'lineColors' | 'lineWidths' | 'lineStyles' | 'barColors'> {
  name: string; pane: 'main' | 'sub'; calcParams?: number[]; visible?: boolean;
}

/** Style overrides of an indicator (the IndicatorSpec fields the settings dialog edits). */
type IndicatorOverrides = Pick<IndicatorSpec, 'lineColors' | 'lineWidths' | 'lineStyles' | 'barColors'>;
const OVERRIDE_KEYS = ['lineColors', 'lineWidths', 'lineStyles', 'barColors'] as const;

/** Style of the selected drawing, as the floating style bar edits it. */
export type SelectedDrawing =
  | { id: string; kind: 'line'; style: DrawingLineStyle; locked: boolean }
  | { id: string; kind: 'text'; style: TextStyle; locked: boolean };

const INDICATOR_DASH = [4, 4];

export interface LoadParams { symbol: SymbolInfo; tf: Timeframe; session: SessionMode; pollMs: number }

const CANDLE_PANE = 'candle_pane';
const MARKERS = 'markers';
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
  /** Passed to every indicator as `extendData` (VWAP picks its session day from it). */
  private indicatorExt: IndicatorExtendData = {};
  private readonly overrides = new Map<string, IndicatorOverrides>();
  private appearance: ChartAppearance | undefined;
  private readonly changeListeners = new Set<() => void>();
  private silent = 0;
  private destroyed = false;

  constructor(el: HTMLElement, opts: { theme: ThemeName }) {
    registerSessionShade();
    registerMarkerOverlay();
    registerCustomIndicators();
    this.el = el;
    this.theme = opts.theme;
    const chart = init(el, { styles: this.styles() });
    if (!chart) throw new Error('Failed to initialise the chart');
    this.chart = chart;
  }

  private styles(): DeepPartial<Styles> {
    const base = chartStyles(this.theme);
    const candle = candleStyles(this.chartType, this.theme, this.appearance);
    return {
      ...base,
      candle: { ...base.candle, ...candle, priceMark: { ...base.candle?.priceMark, ...candle.priceMark } },
      // Unstyled drawings follow the appearance's default drawing style (theme accent when unset).
      overlay: overlayStyles(this.defaultDrawing()),
    };
  }

  private defaultDrawing(): DrawingLineStyle {
    return resolveAppearance(this.theme, this.appearance).drawing;
  }

  // ── data ──────────────────────────────────────────────────────────────────

  load(p: LoadParams, events: LoaderEvents): void {
    this.loader?.dispose(); // its pending results and polling become no-ops while the chart resets below
    this.dataSymbol = null;
    this.loadSymbol = p.symbol.id;
    // Blank the chart at once: KLineChart keeps the previous series until the new init page arrives, which
    // could take several retries (old data must never sit under the new symbol / timeframe).
    this.installEmptyLoader();
    const ready = () => { if (this.loader === loader) this.onDataReady(); };
    const loader = createDataLoader({ session: () => p.session, pollMs: p.pollMs }, {
      onMeta: (m) => events.onMeta(m),
      onError: (e) => { ready(); events.onError(e); }, // never keep drawings hidden because a page failed
      onConnection: (lost, e) => { if (lost) ready(); events.onConnection?.(lost, e); },
      onFatal: (e) => { ready(); events.onFatal?.(e); },
      onReload: () => { if (this.loader === loader) this.chart.resetData(); }, // gap too large to backfill
    });
    this.loader = loader;
    this.tf = p.tf;
    this.markers = [];
    this.renderMarkers();
    this.setIndicatorContext({ assetClass: p.symbol.assetClass, intraday: isIntraday(p.tf), pricePrecision: p.symbol.pricePrecision });
    this.chart.setTimezone(timezoneFor(p.symbol, p.tf));
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
        : { ...params, callback: (data, more) => { params.callback(data, more); this.onBarsAdded(); } }),
      // New bars (polling / backfill) may make a marker placeable, e.g. a basket Start after the last bar.
      subscribeBar: (params) => loader.subscribeBar({ ...params, callback: (bar) => { params.callback(bar); this.onBarsAdded(); } }),
      unsubscribeBar: () => loader.unsubscribeBar(),
    });
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
    this.chart.setStyles(this.styles());
    for (const o of this.chart.getOverlays({ groupId: MARKERS })) this.chart.overrideOverlay({ id: o.id, styles: markerStyles(t) });
  }

  setChartType(t: ChartType): void {
    this.chartType = t;
    this.chart.setStyles(this.styles());
  }

  /** Global chart appearance (candle colours/body, line colour/width, default drawing style); unset = theme. */
  setAppearance(a: ChartAppearance | undefined): void {
    this.appearance = a;
    this.chart.setStyles(this.styles());
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
    if (this.destroyed || this.markers.length === 0) return;
    const key = JSON.stringify(this.markerOverlays().map((o) => [o.extendData, o.points?.[0]?.timestamp]));
    if (key !== this.markersKey) this.renderMarkers();
  }

  // ── indicators ────────────────────────────────────────────────────────────

  /** Default line `i` of indicator `name` (KLineChart palette, or the catalog's own default colour). */
  private defaultLines(name: string): IndicatorStyle['lines'] {
    const palette = this.chart.getStyles().indicator.lines;
    const own = catalogEntry(name)?.defaultColors;
    return palette.map((l, i) => ({ ...l, color: own?.[i] ?? l.color }));
  }

  /**
   * KLineChart styles for the overrides; `reset` lists the kinds (lines / bars) that had overrides before and
   * must be written back to their defaults explicitly when they are gone (KLineChart merges override styles).
   */
  private indicatorStyles(name: string, o: IndicatorOverrides, reset?: IndicatorOverrides): DeepPartial<IndicatorStyle> | undefined {
    const styles: DeepPartial<IndicatorStyle> = {};
    const hasLines = Boolean(o.lineColors || o.lineWidths || o.lineStyles);
    if (hasLines || (reset && (reset.lineColors || reset.lineWidths || reset.lineStyles))) {
      const defaults = this.defaultLines(name);
      const n = hasLines ? Math.max(o.lineColors?.length ?? 0, o.lineWidths?.length ?? 0, o.lineStyles?.length ?? 0) : defaults.length;
      styles.lines = Array.from({ length: n }, (_, i) => {
        const d = defaults[i % defaults.length]!;
        const style = o.lineStyles?.[i] ?? 'solid';
        return {
          ...d,
          color: o.lineColors?.[i] ?? d.color,
          size: o.lineWidths?.[i] ?? 1,
          style,
          dashedValue: style === 'dashed' ? INDICATOR_DASH : d.dashedValue,
        };
      });
    }
    if (o.barColors || reset?.barColors) {
      const d = this.chart.getStyles().indicator.bars[0]!;
      styles.bars = [o.barColors ? { ...d, upColor: o.barColors.up, downColor: o.barColors.down } : { ...d }];
    }
    return styles.lines || styles.bars ? styles : undefined;
  }

  private static overridesOf(spec: Partial<IndicatorSpec>): IndicatorOverrides {
    const o: IndicatorOverrides = {};
    if (spec.lineColors) o.lineColors = spec.lineColors;
    if (spec.lineWidths) o.lineWidths = spec.lineWidths;
    if (spec.lineStyles) o.lineStyles = spec.lineStyles;
    if (spec.barColors) o.barColors = spec.barColors;
    return o;
  }

  addIndicator(spec: IndicatorSpec): string {
    const main = spec.pane === 'main';
    const create: IndicatorCreate = { name: spec.name };
    if (main) create.paneId = CANDLE_PANE;
    if (spec.calcParams) create.calcParams = spec.calcParams;
    if (spec.visible !== undefined) create.visible = spec.visible;
    const overrides = ChartAdapter.overridesOf(spec);
    const styles = this.indicatorStyles(spec.name, overrides);
    if (styles) create.styles = styles;
    create.extendData = this.indicatorExt;
    if (PRICE_PRECISION_INDICATORS.has(spec.name)) create.precision = this.indicatorExt.pricePrecision ?? 4;
    const id = this.chart.createIndicator(create, main);
    if (!id) throw new Error(`Cannot create indicator ${spec.name}`);
    if (styles) this.overrides.set(id, overrides);
    return id;
  }

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
    this.chart.overrideIndicator(override);
    if (OVERRIDE_KEYS.some((k) => next[k])) this.overrides.set(id, next);
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
      if (PRICE_PRECISION_INDICATORS.has(i.name)) override.precision = ext.pricePrecision;
      this.chart.overrideIndicator(override);
    }
  }

  removeIndicator(id: string): void {
    this.chart.removeIndicator({ id });
    this.overrides.delete(id);
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
  private lockAll = false;
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

  private readonly handlers: Pick<OverlayCreate, 'onDrawEnd' | 'onPressedMoveStart' | 'onPressedMoveEnd' | 'onRemoved' | 'onSelected' | 'onDeselected'> = {
    onDrawEnd: ({ overlay }) => {
      if (this.drawing?.id === overlay.id) {
        const { onEnd } = this.drawing;
        this.drawing = null;
        if (this.lockAll) this.chart.overrideOverlay({ id: overlay.id, lock: true });
        this.revertMode(overlay.id);
        onEnd?.();
        this.emitSelection(); // the style bar is hidden while a drawing is being placed
      }
      this.emitChange();
    },
    onPressedMoveStart: ({ overlay }) => {
      this.draggingId = overlay.id;
      if (this.strongMagnet) this.applyStrong(overlay.id);
    },
    onPressedMoveEnd: ({ overlay }) => {
      if (this.draggingId === overlay.id) this.draggingId = null;
      this.revertMode(overlay.id);
      this.emitChange();
    },
    onRemoved: ({ overlay }) => {
      if (this.selectedId === overlay.id) this.select(null);
      if (this.drawing?.id === overlay.id) this.endDrawing();
      if (this.draggingId === overlay.id) this.draggingId = null;
      this.strongIds.delete(overlay.id);
      this.removing.add(overlay.id);
      try { this.emitChange(); } finally { this.removing.delete(overlay.id); }
    },
    onSelected: ({ overlay }) => { this.select(overlay.id); },
    onDeselected: ({ overlay }) => { if (this.selectedId === overlay.id) this.select(null); },
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
      return { id: o.id, kind: 'text', style, locked: o.lock };
    }
    const style = readLine(o.styles) ?? { ...d };
    return { id: o.id, kind: 'line', style, locked: o.lock };
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
    if (!sel || sel.locked) return;
    const styles = sel.kind === 'text'
      ? textToOverlay({ ...sel.style, ...(patch as Partial<TextStyle>) })
      : lineToOverlay({ ...sel.style, ...(patch as Partial<DrawingLineStyle>) });
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
    this.lockAll = locked;
    let changed = false;
    for (const o of this.userOverlays()) {
      if (o.id === this.drawing?.id || o.lock === locked) continue;
      this.chart.overrideOverlay({ id: o.id, lock: locked });
      changed = true;
    }
    this.emitLockState();
    if (changed) {
      this.emitChange();
      this.emitSelection();
    }
  }

  /**
   * Fired with the effective "lock all" state: on setLockAll and whenever drawings are restored or cleared
   * (true iff there are drawings and every one is locked). Returns an unsubscribe function.
   */
  onLockAllChange(cb: (locked: boolean) => void): () => void {
    this.lockListeners.add(cb);
    return () => { this.lockListeners.delete(cb); };
  }

  private emitLockState(): void {
    if (this.destroyed) return;
    for (const cb of this.lockListeners) cb(this.lockAll);
  }

  private deriveLockAll(drawings: DrawingState[]): void {
    this.lockAll = drawings.length > 0 && drawings.every((d) => d.lock);
    this.emitLockState();
  }

  serializeDrawings(): DrawingState[] {
    if (this.pendingRestore) return this.pendingRestore.drawings.map(sanitizeDrawing);
    const out: DrawingState[] = [];
    for (const o of this.userOverlays()) {
      const points = completePoints(o); // skips an overlay that is still being drawn
      if (!points || o.id === this.drawing?.id) continue;
      const d: DrawingState = { name: o.name, points, lock: o.lock };
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
  }

  private createDrawings(drawings: DrawingState[]): void {
    this.withSilence(() => {
      for (const d of drawings) {
        const create: OverlayCreate = { name: d.name, points: d.points, lock: d.lock, ...this.handlers };
        if (d.text !== undefined) create.extendData = d.text;
        const styles = toOverlayStyles(sanitizeDrawingStyles(d.styles));
        if (styles) create.styles = styles;
        this.chart.createOverlay(create);
      }
    });
  }

  private onDataReady(): void {
    this.dataSymbol = this.loadSymbol;
    const pending = this.pendingRestore;
    if (!pending || (pending.symbol !== undefined && pending.symbol !== this.dataSymbol)) return;
    this.pendingRestore = null;
    this.createDrawings(pending.drawings);
  }

  clearDrawings(): void {
    const had = this.userOverlays().length > 0 || this.pendingRestore !== null;
    this.endDrawing();
    this.pendingRestore = null;
    this.deriveLockAll([]);
    this.withSilence(() => this.removeUserOverlays());
    if (had) this.emitChange();
  }

  private removeUserOverlays(): void {
    for (const o of this.userOverlays()) this.chart.removeOverlay({ id: o.id });
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
    this.loader?.dispose();
    this.loader = null;
    this.changeListeners.clear();
    this.lockListeners.clear();
    this.selectionListeners.clear();
    dispose(this.el);
  }
}

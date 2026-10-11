import {
  dispose, init,
  type Chart, type DeepPartial, type IndicatorCreate, type KLineData, type Overlay, type OverlayCreate, type Styles,
} from 'klinecharts';
import {
  isIntraday, tfMs,
  type ChartType, type DrawingState, type Marker, type SessionMode, type SymbolInfo, type Timeframe,
} from '@altv/shared';
import { createDataLoader, type DataLoaderImpl, type LoaderEvents } from './dataLoader';
import { registerCustomIndicators } from './indicators/register';
import type { IndicatorExtendData } from './indicators/types';
import { toPeriod } from './periods';
import { registerSessionShade, SESSION_SHADE } from './sessionShade';
import { chartStyles, THEME_TOKENS, type ThemeName } from './theme';

export type DrawingTool =
  | 'segment' | 'rayLine' | 'straightLine' | 'horizontalStraightLine' | 'verticalStraightLine'
  | 'priceLine' | 'parallelStraightLine' | 'fibonacciLine' | 'simpleAnnotation';

export interface IndicatorSpec { name: string; pane: 'main' | 'sub'; calcParams?: number[]; visible?: boolean; lineColors?: string[] }

export interface LoadParams { symbol: SymbolInfo; tf: Timeframe; session: SessionMode; pollMs: number }

const CANDLE_PANE = 'candle_pane';
const MARKERS = 'markers';
const TRANSPARENT = 'rgba(0,0,0,0)';

function candleStyles(type: ChartType, theme: ThemeName): DeepPartial<Styles['candle']> {
  const accent = THEME_TOKENS[theme].accent;
  switch (type) {
    case 'candle': return { type: 'candle_solid' };
    case 'ohlc': return { type: 'ohlc' };
    case 'line':
      return {
        type: 'area',
        area: { lineColor: accent, lineSize: 2, backgroundColor: [{ offset: 0, color: TRANSPARENT }, { offset: 1, color: TRANSPARENT }] },
      };
    case 'area':
      return {
        type: 'area',
        area: { lineColor: accent, lineSize: 2, backgroundColor: [{ offset: 0, color: 'rgba(41,98,255,0.02)' }, { offset: 1, color: 'rgba(41,98,255,0.28)' }] },
      };
  }
}

/** Chart timezone: exchange time for intraday stock/basket charts, UTC otherwise (daily+ bars are UTC dates). */
function timezoneFor(symbol: SymbolInfo, tf: Timeframe): string {
  return isIntraday(tf) && symbol.assetClass !== 'crypto' ? 'America/New_York' : 'UTC';
}

const lineStyles = (colors: string[] | undefined) => (colors ? { lines: colors.map((color) => ({ color })) } : undefined);

function completePoints(o: Overlay): Array<{ timestamp: number; value: number }> | null {
  const pts: Array<{ timestamp: number; value: number }> = [];
  for (const p of o.points) {
    if (typeof p.timestamp !== 'number' || typeof p.value !== 'number') return null;
    pts.push({ timestamp: p.timestamp, value: p.value });
  }
  return pts.length > 0 ? pts : null;
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
  private readonly lineColors = new Map<string, string[]>();
  private readonly changeListeners = new Set<() => void>();
  private silent = 0;
  private destroyed = false;

  constructor(el: HTMLElement, opts: { theme: ThemeName }) {
    registerSessionShade();
    registerCustomIndicators();
    this.el = el;
    this.theme = opts.theme;
    const chart = init(el, { styles: this.styles() });
    if (!chart) throw new Error('Failed to initialise the chart');
    this.chart = chart;
  }

  private styles(): DeepPartial<Styles> {
    const base = chartStyles(this.theme);
    return { ...base, candle: { ...base.candle, ...candleStyles(this.chartType, this.theme) } };
  }

  // ── data ──────────────────────────────────────────────────────────────────

  load(p: LoadParams, events: LoaderEvents): void {
    this.loader?.dispose(); // its pending results and polling become no-ops while the chart resets below
    this.hasData = false;
    const ready = () => { if (this.loader === loader) this.onDataReady(); };
    const loader = createDataLoader({ session: () => p.session, pollMs: p.pollMs }, {
      onMeta: (m) => events.onMeta(m),
      onError: (e) => { ready(); events.onError(e); }, // never keep drawings hidden because a page failed
    });
    this.loader = loader;
    this.tf = p.tf;
    this.markers = [];
    this.renderMarkers();
    this.setIndicatorAssetClass(p.symbol.assetClass);
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
        : params),
      subscribeBar: (params) => loader.subscribeBar(params),
      unsubscribeBar: () => loader.unsubscribeBar(),
    });
  }

  // ── appearance ────────────────────────────────────────────────────────────

  setTheme(t: ThemeName): void {
    this.theme = t;
    this.chart.setStyles(this.styles());
  }

  setChartType(t: ChartType): void {
    this.chartType = t;
    this.chart.setStyles(this.styles());
  }

  setSessionShading(enabled: boolean): void {
    const existing = this.chart.getIndicators({ name: SESSION_SHADE });
    if (enabled && existing.length === 0) {
      this.chart.createIndicator({ name: SESSION_SHADE, paneId: CANDLE_PANE }, true);
    } else if (!enabled && existing.length > 0) {
      this.chart.removeIndicator({ name: SESSION_SHADE });
    }
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers;
    this.renderMarkers();
  }

  private renderMarkers(): void {
    this.withSilence(() => this.chart.removeOverlay({ groupId: MARKERS }));
    const data = this.chart.getDataList();
    const first = data[0];
    if (!first || this.markers.length === 0) return;
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
        name: 'simpleAnnotation', groupId: MARKERS, lock: true, extendData: m.label,
        points: [{ timestamp: bar.timestamp, value: bar.high }],
      });
    }
    for (const o of overlays) this.chart.createOverlay(o);
  }

  // ── indicators ────────────────────────────────────────────────────────────

  addIndicator(spec: IndicatorSpec): string {
    const main = spec.pane === 'main';
    const create: IndicatorCreate = { name: spec.name };
    if (main) create.paneId = CANDLE_PANE;
    if (spec.calcParams) create.calcParams = spec.calcParams;
    if (spec.visible !== undefined) create.visible = spec.visible;
    const styles = lineStyles(spec.lineColors);
    if (styles) create.styles = styles;
    create.extendData = this.indicatorExt;
    const id = this.chart.createIndicator(create, main);
    if (!id) throw new Error(`Cannot create indicator ${spec.name}`);
    if (spec.lineColors) this.lineColors.set(id, spec.lineColors);
    return id;
  }

  updateIndicator(id: string, spec: Partial<IndicatorSpec>): void {
    const existing = this.chart.getIndicators().find((i) => i.id === id);
    if (!existing) return;
    const override: IndicatorCreate = { id, name: existing.name };
    if (spec.calcParams) override.calcParams = spec.calcParams;
    if (spec.visible !== undefined) override.visible = spec.visible;
    if (spec.lineColors) {
      override.styles = lineStyles(spec.lineColors);
    } else if (this.lineColors.has(id)) {
      // No colours any more: KLineChart merges override styles, so write the default line colours back explicitly.
      override.styles = lineStyles(this.chart.getStyles().indicator.lines.map((l) => l.color));
    }
    this.chart.overrideIndicator(override);
    if (spec.lineColors) this.lineColors.set(id, spec.lineColors);
    else this.lineColors.delete(id);
  }

  private setIndicatorAssetClass(assetClass: SymbolInfo['assetClass']): void {
    if (this.indicatorExt.assetClass === assetClass) return;
    this.indicatorExt = { assetClass };
    for (const i of this.chart.getIndicators()) {
      if (i.name !== SESSION_SHADE) this.chart.overrideIndicator({ id: i.id, name: i.name, extendData: this.indicatorExt });
    }
  }

  removeIndicator(id: string): void {
    this.chart.removeIndicator({ id });
    this.lineColors.delete(id);
  }

  listIndicators(): Array<{ id: string } & IndicatorSpec> {
    return this.chart.getIndicators()
      .filter((i) => i.name !== SESSION_SHADE)
      .map((i) => {
        const spec: { id: string } & IndicatorSpec = {
          id: i.id,
          name: i.name,
          pane: i.paneId === CANDLE_PANE ? 'main' : 'sub',
          calcParams: i.calcParams as number[],
          visible: i.visible,
        };
        const colors = this.lineColors.get(i.id);
        if (colors) spec.lineColors = colors;
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
  /** False from load() until the first data page of that load arrives; restores are queued meanwhile. */
  private hasData = false;
  private pendingRestore: DrawingState[] | null = null;
  /** KLineChart fires onRemoved while the overlay is still listed; hide it from serializeDrawings meanwhile. */
  private readonly removing = new Set<string>();

  private readonly handlers: Pick<OverlayCreate, 'onDrawEnd' | 'onPressedMoveEnd' | 'onRemoved' | 'onSelected' | 'onDeselected'> = {
    onDrawEnd: ({ overlay }) => {
      if (this.drawing?.id === overlay.id) {
        const { onEnd } = this.drawing;
        this.drawing = null;
        if (this.lockAll) this.chart.overrideOverlay({ id: overlay.id, lock: true });
        onEnd?.();
      }
      this.emitChange();
    },
    onPressedMoveEnd: () => this.emitChange(),
    onRemoved: ({ overlay }) => {
      if (this.selectedId === overlay.id) this.selectedId = null;
      if (this.drawing?.id === overlay.id) this.drawing = null;
      this.removing.add(overlay.id);
      try { this.emitChange(); } finally { this.removing.delete(overlay.id); }
    },
    onSelected: ({ overlay }) => { this.selectedId = overlay.id; },
    onDeselected: ({ overlay }) => { if (this.selectedId === overlay.id) this.selectedId = null; },
  };

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
    const create: OverlayCreate = { name: tool, mode: this.magnet ? 'weak_magnet' : 'normal', ...this.handlers };
    if (opts?.text !== undefined) create.extendData = opts.text;
    const id = this.chart.createOverlay(create);
    if (typeof id === 'string') this.drawing = opts?.onEnd ? { id, onEnd: opts.onEnd } : { id };
  }

  /** Abandons the drawing being placed (if any). Finished drawings are untouched. */
  cancelDrawing(): void {
    const d = this.drawing;
    if (!d) return;
    this.drawing = null;
    this.withSilence(() => this.chart.removeOverlay({ id: d.id }));
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
    if (changed) this.emitChange();
  }

  serializeDrawings(): DrawingState[] {
    if (this.pendingRestore) return this.pendingRestore.map((d) => ({ ...d }));
    const out: DrawingState[] = [];
    for (const o of this.userOverlays()) {
      const points = completePoints(o); // skips an overlay that is still being drawn
      if (!points || o.id === this.drawing?.id) continue;
      const d: DrawingState = { name: o.name, points, lock: o.lock };
      if (typeof o.extendData === 'string') d.text = o.extendData;
      if (o.styles) d.styles = o.styles;
      out.push(d);
    }
    return out;
  }

  /**
   * Replaces all user drawings. Does not fire onDrawingsChange. Existing drawings are removed at once; the new
   * ones are created when the current load's first data page has arrived (queued until then).
   */
  restoreDrawings(drawings: DrawingState[]): void {
    this.drawing = null;
    this.withSilence(() => this.removeUserOverlays());
    this.pendingRestore = null;
    if (drawings.length === 0) return;
    if (!this.hasData) {
      this.pendingRestore = drawings;
      return;
    }
    this.createDrawings(drawings);
  }

  private createDrawings(drawings: DrawingState[]): void {
    this.withSilence(() => {
      for (const d of drawings) {
        const create: OverlayCreate = { name: d.name, points: d.points, lock: d.lock || this.lockAll, ...this.handlers };
        if (d.text !== undefined) create.extendData = d.text;
        if (d.styles) create.styles = d.styles as OverlayCreate['styles'];
        this.chart.createOverlay(create);
      }
    });
  }

  private onDataReady(): void {
    this.hasData = true;
    const pending = this.pendingRestore;
    this.pendingRestore = null;
    if (pending) this.createDrawings(pending);
  }

  clearDrawings(): void {
    const had = this.userOverlays().length > 0 || this.pendingRestore !== null;
    this.drawing = null;
    this.pendingRestore = null;
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
    dispose(this.el);
  }
}

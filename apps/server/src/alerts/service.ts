import {
  alertTargets, barIndexer, checkAlert, nyToUtc, parseSymbolId, tfMs,
  type AlertMemory, type AlertNotice, type Bar, type DrawingAlert, type DrawingState, type SymbolId,
} from '@chartmate/shared';
import type { BasketService } from '../baskets/service.js';
import type { Repos } from '../db/repos.js';
import type { MarketDataService } from '../market/service.js';

/**
 * Checks the alerts set on drawings (watched where the host can tell the user: the desktop app's native
 * notifications) and calls `notify` when one fires. Every `intervalMs` it reads the drawings, takes each alert's
 * timeframe bars from the market (or basket) service, as the chart would, and runs the shared rules
 * (@chartmate/shared alerts.ts) on the latest price. What each alert remembers (where the price was, whether it
 * fired) is kept in the settings under its id, so a restart neither repeats nor forgets a fired alert.
 */

export interface AlertNotification extends AlertNotice { symbol: SymbolId }

/** How an alert stands, as the page shows it. */
export interface AlertStatus {
  /** armed: watching; open: a position's entry was reached; fired: done (re-arm to watch again). */
  status: 'armed' | 'open' | 'fired';
  at: number | null;
  message: string | null;
}

export const ALERT_INTERVAL_MS = 30_000;
const MEMORY_KEY = 'alert_memory';
/** Most bars read back for a sloped drawing (older points are placed by whole periods, as the chart does past its data). */
const MAX_LOOKBACK_BARS = 5_000;

interface Watched { symbol: SymbolId; drawing: DrawingState; alert: DrawingAlert }

export class AlertService {
  private readonly repos: Repos;
  private readonly market: MarketDataService;
  private readonly baskets: BasketService;
  private readonly notify: (n: AlertNotification) => void;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly precision = new Map<SymbolId, number>();

  constructor(deps: {
    repos: Repos; market: MarketDataService; baskets: BasketService; notify: (n: AlertNotification) => void;
    now?: () => number; intervalMs?: number;
  }) {
    this.repos = deps.repos;
    this.market = deps.market;
    this.baskets = deps.baskets;
    this.notify = deps.notify;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? ALERT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  /** Stops checking; resolves once a round still running has finished (the database must outlive it). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * One round over every armed alert (a round already running is joined, not doubled). Never rejects: a round that
   * fails (the database or the market data unavailable) is simply tried again next time.
   */
  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.round().catch(() => { /* next round */ }).finally(() => { this.running = null; });
    return this.running;
  }

  /** The status of every alert that has a memory (an alert without one is armed and has seen no price yet). */
  async statuses(): Promise<Record<string, AlertStatus>> {
    const out: Record<string, AlertStatus> = {};
    for (const [id, m] of Object.entries(await this.memory())) {
      out[id] = m.fired ? { status: 'fired', at: m.fired.at, message: m.fired.message }
        : m.open ? { status: 'open', at: m.open.at, message: null }
        : { status: 'armed', at: null, message: null };
    }
    return out;
  }

  /** Watches a fired alert again (its memory is dropped: the next price only records the side). */
  async rearm(id: string): Promise<void> {
    await this.running;
    const memory = await this.memory();
    if (!(id in memory)) return;
    delete memory[id];
    await this.repos.settings.set(MEMORY_KEY, JSON.stringify(memory));
  }

  private async memory(): Promise<Record<string, AlertMemory>> {
    const raw = await this.repos.settings.get(MEMORY_KEY);
    if (raw === null) return {};
    try {
      const m = JSON.parse(raw) as unknown;
      return typeof m === 'object' && m !== null ? m as Record<string, AlertMemory> : {};
    } catch {
      return {};
    }
  }

  private async round(): Promise<void> {
    const watched: Watched[] = [];
    /** Every alert, armed or not: the memory of one switched off is kept (back on, a fired one must not repeat). */
    const known = new Set<string>();
    for (const { symbol, drawings } of await this.repos.drawings.list()) {
      for (const drawing of drawings) {
        if (!drawing.alert) continue;
        known.add(drawing.alert.id);
        if (drawing.alert.on) watched.push({ symbol, drawing, alert: drawing.alert });
      }
    }
    const before = await this.memory();
    const memory: Record<string, AlertMemory> = {};
    for (const [id, m] of Object.entries(before)) if (known.has(id)) memory[id] = m;

    // One bar read per symbol, timeframe and session.
    const groups = new Map<string, Watched[]>();
    for (const w of watched) {
      const k = `${w.symbol}|${w.alert.tf}|${w.alert.session}`;
      groups.set(k, [...(groups.get(k) ?? []), w]);
    }
    for (const group of groups.values()) {
      try {
        await this.checkGroup(group, memory);
      } catch {
        // A symbol whose data cannot be read now is checked again next round.
      }
    }
    if (JSON.stringify(memory) !== JSON.stringify(before)) await this.repos.settings.set(MEMORY_KEY, JSON.stringify(memory));
  }

  private async checkGroup(group: Watched[], memory: Record<string, AlertMemory>): Promise<void> {
    const { symbol, alert: { tf, session } } = group[0]!;
    const now = this.now();
    const earliest = Math.min(...group.flatMap((w) => w.drawing.points.map((p) => p.timestamp)));
    const from = Math.max(earliest - tfMs(tf), now - MAX_LOOKBACK_BARS * tfMs(tf));
    const bars = await this.bars(symbol, tf, session, Math.min(from, now - 2 * tfMs(tf)), now + tfMs(tf));
    const latest = bars.at(-1);
    if (!latest) return;
    const index = barIndexer(bars, tf);
    const at = bars.length - 1;
    const ticker = await this.ticker(symbol);
    const precision = await this.pricePrecision(symbol);
    for (const { drawing, alert } of group) {
      const d = anchored(drawing, tf, symbol);
      const r = checkAlert(d, alert, alertTargets(d, alert, index, at), memory[alert.id], { ticker, price: latest.close, now: latest.ts, precision });
      memory[alert.id] = r.memory;
      if (r.notice) {
        try {
          this.notify({ ...r.notice, symbol });
        } catch {
          // The notification could not be shown: the alert still counts as fired.
        }
      }
    }
  }

  private async bars(symbol: SymbolId, tf: DrawingAlert['tf'], session: DrawingAlert['session'], from: number, to: number): Promise<Bar[]> {
    const id = parseSymbolId(symbol);
    if (id.assetClass === 'basket') return (await this.baskets.getBars({ id: id.code, tf, session, from, to })).bars;
    return (await this.market.getBars({ symbol, tf, session, from, to })).bars;
  }

  private async ticker(symbol: SymbolId): Promise<string> {
    const id = parseSymbolId(symbol);
    if (id.assetClass !== 'basket') return id.code;
    try {
      return (await this.baskets.get(id.code)).name;
    } catch {
      return 'Basket';
    }
  }

  private async pricePrecision(symbol: SymbolId): Promise<number> {
    const known = this.precision.get(symbol);
    if (known !== undefined) return known;
    let p = 2;
    if (parseSymbolId(symbol).assetClass !== 'basket') {
      try {
        p = (await this.market.symbolInfo(symbol)).pricePrecision;
      } catch {
        // Unknown for now: two decimals.
      }
    }
    this.precision.set(symbol, p);
    return p;
  }
}

/**
 * A drawing placed on a daily-or-longer stock or basket chart stores its dates at midnight UTC; intraday charts show those
 * points at that date's 09:30 New York open (see the web app's ChartAdapter). Measured the same way here.
 */
function anchored(d: DrawingState, tf: DrawingAlert['tf'], symbol: SymbolId): DrawingState {
  if (!d.anchorTf || tf === '1D' || tf === '1W' || tf === '1M' || parseSymbolId(symbol).assetClass === 'crypto') return d;
  return {
    ...d,
    points: d.points.map((p) => {
      const t = new Date(p.timestamp);
      return { ...p, timestamp: nyToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 9, 30) };
    }),
  };
}

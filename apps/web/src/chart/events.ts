import { registerOverlay } from 'klinecharts';
import type { CorporateEvent, CorporateEventKind, ThemedAppearance } from '@chartmate/shared';
import { readableTextOnAll } from './contrast';
import { CHART_FONT, resolvePaletteColor, themeTokens, type ThemeName } from './theme';

/**
 * Corporate events on stock charts (earnings, dividends, splits): one small lettered badge per kind at the bottom of
 * the price pane, on the bar the event falls in; several kinds on one bar stack upward (earnings at the bottom).
 */
export const EVENT_OVERLAY = 'chartmateEvent';
/** Badge radius, gap between stacked badges and distance from the bottom of the pane (px). */
export const EVENT_BADGE_R = 8;
const EVENT_BADGE_GAP = 3;
export const EVENT_BADGE_BOTTOM = 6;

const KIND_ORDER: readonly CorporateEventKind[] = ['earnings', 'dividend', 'split'];
const LETTER: Record<CorporateEventKind, string> = { earnings: 'E', dividend: 'D', split: 'S' };

/** The events of one bar (or, for an upcoming report after the last bar, of its own time), kinds in KIND_ORDER. */
export interface EventGroup { barTs: number; events: CorporateEvent[] }

/** One badge: its letter, fill, letter color and, for an upcoming report, the ring drawn around a background fill. */
export interface EventBadge { letter: string; fill: string; text: string; ring?: string }

/** What the overlay draws: the bar's badges, bottom-up. */
export interface EventOverlayData { badges: EventBadge[] }

/** First index whose timestamp is >= ts (bars sorted ascending). */
function lowerBound(bars: ReadonlyArray<{ timestamp: number }>, ts: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Groups the shown events by the bar that contains them (bars `width` ms long). Events before the first bar are left
 * out, and so are past events after the last bar (not loaded yet); an upcoming report after the last bar keeps its own
 * time, so it is drawn in the space right of the bars.
 */
export function eventGroups(
  events: readonly CorporateEvent[], bars: ReadonlyArray<{ timestamp: number }>, width: number, hidden: readonly CorporateEventKind[],
): EventGroup[] {
  const first = bars[0];
  const last = bars.at(-1);
  if (!first || !last) return [];
  const byBar = new Map<number, CorporateEvent[]>();
  for (const e of events) {
    if (hidden.includes(e.kind) || e.ts < first.timestamp) continue;
    let barTs: number;
    if (e.ts >= last.timestamp + width) {
      if (!(e.kind === 'earnings' && e.upcoming)) continue;
      barTs = e.ts;
    } else {
      let i = lowerBound(bars, e.ts);
      if (bars[i]?.timestamp !== e.ts) i -= 1; // the bar that started before it contains it
      barTs = bars[i]!.timestamp;
    }
    const list = byBar.get(barTs);
    if (list) list.push(e);
    else byBar.set(barTs, [e]);
  }
  return [...byBar.entries()]
    .sort(([a], [b]) => a - b)
    .map(([barTs, list]) => ({ barTs, events: [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.ts - b.ts) }));
}

/**
 * The badge of one kind's events on a bar (the latest one decides an earnings badge's color): earnings in the up color
 * when they beat the estimate, the down color when they missed, the accent otherwise (no figures), and hollow with an
 * accent ring when upcoming; dividends gold, splits violet. The letter is drawn in the chart background color when it
 * reads there, else in the more readable of white and near-black.
 */
export function eventBadge(events: readonly CorporateEvent[], theme: ThemeName, appearance?: ThemedAppearance): EventBadge {
  const t = themeTokens(theme);
  const e = events.at(-1)!;
  if (e.kind === 'earnings' && e.upcoming) return { letter: LETTER.earnings, fill: t.bg, text: t.accent, ring: t.accent };
  let fill: string;
  if (e.kind === 'earnings') {
    const result = e.epsActual !== undefined && e.epsEstimate !== undefined ? Math.sign(e.epsActual - e.epsEstimate) : null;
    fill = result === null || result === 0 ? t.accent : resolvePaletteColor(result > 0 ? 'up' : 'down', theme, appearance);
  } else {
    fill = resolvePaletteColor(e.kind === 'dividend' ? 'palette:0' : 'palette:1', theme, appearance);
  }
  return { letter: LETTER[e.kind], fill, text: readableTextOnAll([fill], t.bg) };
}

/** The badges of a group, bottom-up: one per kind. */
export function groupBadges(group: EventGroup, theme: ThemeName, appearance?: ThemedAppearance): EventBadge[] {
  return KIND_ORDER.flatMap((kind) => {
    const of = group.events.filter((e) => e.kind === kind);
    return of.length > 0 ? [eventBadge(of, theme, appearance)] : [];
  });
}

/** Height of a stack of `n` badges, from the bottom of the pane to the top of the highest one (px). */
export function badgeStackHeight(n: number): number {
  return n <= 0 ? 0 : EVENT_BADGE_BOTTOM + n * 2 * EVENT_BADGE_R + (n - 1) * EVENT_BADGE_GAP;
}

export function eventTitle(e: CorporateEvent): string {
  switch (e.kind) {
    case 'earnings': return e.upcoming ? 'Earnings (expected)' : 'Earnings';
    case 'dividend': return 'Dividend';
    case 'split': return 'Split';
  }
}

const NY_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

/** The event's New York date; for earnings also "before the open" (before 09:30) or "after the close" (16:00 on). */
export function eventWhen(e: CorporateEvent): string {
  const date = NY_DATE.format(e.ts);
  if (e.kind !== 'earnings') return date;
  const [h, m] = NY_HOUR.format(e.ts).split(':').map(Number) as [number, number];
  const minutes = h * 60 + m;
  if (minutes >= 16 * 60) return `${date}, after the close`;
  if (minutes < 9 * 60 + 30) return `${date}, before the open`;
  return date;
}

const eps = (x: number) => x.toFixed(2);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** One line of figures: EPS against the estimate (and the surprise), the dividend per share, or the split ratio. */
export function eventDetail(e: CorporateEvent): string {
  switch (e.kind) {
    case 'earnings': {
      if (e.upcoming || e.epsActual === undefined) return e.epsEstimate !== undefined && e.epsActual === undefined ? `EPS estimate ${eps(e.epsEstimate)}` : '';
      if (e.epsEstimate === undefined) return `EPS ${eps(e.epsActual)}`;
      const diff = e.epsActual - e.epsEstimate;
      const pct = e.epsEstimate === 0 ? null : Math.abs(diff / e.epsEstimate) * 100;
      const result = diff === 0 ? 'in line' : `${diff > 0 ? 'beat' : 'missed'}${pct === null ? '' : ` by ${pct.toFixed(1)}%`}`;
      return `EPS ${eps(e.epsActual)} vs ${eps(e.epsEstimate)} estimated, ${result}`;
    }
    case 'dividend': return `${usd.format(e.amount)} per share`;
    case 'split': {
      const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(e.ratio);
      if (!m) return e.ratio;
      const [n, d] = [Number(m[1]), Number(m[2])];
      return `${m[1]}-for-${m[2]}${n < d ? ' (reverse split)' : ''}`;
    }
  }
}

let registered = false;

/**
 * Registers the event badge template once: at its point's bar, the badges of `extendData` (EventOverlayData) stacked
 * up from the bottom of the pane, each a filled circle (or a ring around the background) with its letter.
 */
export function registerEventOverlay(): void {
  if (registered) return;
  registered = true;
  registerOverlay<EventOverlayData>({
    name: EVENT_OVERLAY,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      const badges = overlay.extendData?.badges ?? [];
      if (x === undefined) return [];
      return badges.flatMap((b, i) => {
        const y = bounding.height - EVENT_BADGE_BOTTOM - EVENT_BADGE_R - i * (2 * EVENT_BADGE_R + EVENT_BADGE_GAP);
        return [
          {
            type: 'circle', attrs: { x, y, r: EVENT_BADGE_R },
            styles: b.ring ? { style: 'stroke_fill', color: b.fill, borderColor: b.ring, borderSize: 1.5 } : { style: 'fill', color: b.fill },
          },
          {
            type: 'text', attrs: { x, y, text: b.letter, align: 'center', baseline: 'middle' }, ignoreEvent: true,
            styles: {
              color: b.text, size: 10, weight: 600, family: CHART_FONT, backgroundColor: 'rgba(0,0,0,0)', borderSize: 0,
              paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
            },
          },
        ];
      });
    },
  });
}

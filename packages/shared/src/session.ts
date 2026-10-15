import type { Bar, Session, SessionMode } from './types.js';
import { memoByNyDay, nyParts, nyToUtc } from './nytime.js';

/** Explicit session window, [start, end) in UTC epoch ms. */
export interface SessionWindow { start: number; end: number; session: Session }

/**
 * Fallback session hours, Monday to Friday (NY date): 04:00–09:30 pre, 09:30–16:00 regular, 16:00–20:00 post, else
 * null; weekends are null. Holidays and early closes are not modeled here: they come from the provider's session
 * windows (see `tagSessions`).
 */
export function tagSessionFixedHours(ts: number): Session | null {
  const p = nyParts(ts);
  if (p.dow === 0 || p.dow === 6) return null;
  const min = p.hh * 60 + p.mm;
  if (min >= 240 && min < 570) return 'pre';
  if (min >= 570 && min < 960) return 'regular';
  if (min >= 960 && min < 1200) return 'post';
  return null;
}

const HOUR_MS = 3_600_000;

/**
 * `tagSessionFixedHours`, memoized per NY day: the day's session bounds in UTC are computed once (Intl lookups are
 * slow), then each timestamp is a few comparisons.
 */
function fixedHoursTagger(): (ts: number) => Session | null {
  const boundsOf = memoByNyDay((day) => {
    if (day.dow === 0 || day.dow === 6) return null;
    // A 24-hour day has one UTC offset throughout; otherwise (a DST change) resolve each bound on its own.
    const at = (hh: number, mm: number) => day.end - day.start === 24 * HOUR_MS
      ? day.start + hh * HOUR_MS + mm * 60_000
      : nyToUtc(day.y, day.m, day.d, hh, mm);
    return [at(4, 0), at(9, 30), at(16, 0), at(20, 0)] as const;
  });
  return (ts) => {
    const b = boundsOf(ts);
    if (!b) return null;
    if (ts < b[0]) return null;
    if (ts < b[1]) return 'pre';
    if (ts < b[2]) return 'regular';
    if (ts < b[3]) return 'post';
    return null;
  };
}

interface Segment { start: number; end: number; session: Session }

/**
 * Flattens (possibly overlapping, unsorted) windows into sorted, disjoint segments. Where windows
 * overlap, the window that comes FIRST in the input array wins (first-match-wins), exactly as a
 * linear `windows.find(...)` would. Empty windows (start >= end) are ignored. O(w log w).
 */
function flattenWindows(windows: SessionWindow[]): Segment[] {
  const valid = windows
    .map((w, idx) => ({ ...w, idx }))
    .filter((w) => w.start < w.end);
  if (valid.length === 0) return [];
  const byStart = valid.slice().sort((a, b) => a.start - b.start);
  const bounds = [...new Set(valid.flatMap((w) => [w.start, w.end]))].sort((a, b) => a - b);
  // min-heap of active windows keyed by input index (lazy deletion of expired ones)
  const heap: typeof valid = [];
  const push = (w: (typeof valid)[number]) => {
    heap.push(w);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.idx <= heap[i]!.idx) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = () => {
    const last = heap.pop()!;
    if (heap.length === 0) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && heap[l]!.idx < heap[m]!.idx) m = l;
      if (r < heap.length && heap[r]!.idx < heap[m]!.idx) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i]!, heap[m]!];
      i = m;
    }
  };
  const out: Segment[] = [];
  let next = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const p = bounds[i]!, q = bounds[i + 1]!;
    while (next < byStart.length && byStart[next]!.start <= p) push(byStart[next++]!);
    while (heap.length > 0 && heap[0]!.end <= p) pop();
    const top = heap[0];
    if (!top) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === p && prev.session === top.session) prev.end = q;
    else out.push({ start: p, end: q, session: top.session });
  }
  return out;
}

function findSegment(segs: Segment[], ts: number): Segment | undefined {
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid]!;
    if (ts < s.start) hi = mid - 1;
    else if (ts >= s.end) lo = mid + 1;
    else return s;
  }
  return undefined;
}

/**
 * Returns new bars with `session` set; windows win over fixed hours; bars in no session are dropped.
 * Windows are [start, end). If windows overlap, the first matching window in input order wins.
 * Lookup is O(log w) per bar (windows are flattened into sorted disjoint segments once).
 */
export function tagSessions(bars: Bar[], windows?: SessionWindow[]): Bar[] {
  const segs = windows && windows.length > 0 ? flattenWindows(windows) : [];
  const fixedHours = fixedHoursTagger();
  const out: Bar[] = [];
  for (const bar of bars) {
    const w = segs.length > 0 ? findSegment(segs, bar.ts) : undefined;
    const session = w ? w.session : fixedHours(bar.ts);
    if (session) out.push({ ...bar, session });
  }
  return out;
}

/**
 * Keeps the bars of `mode` ('eth': all; 'rth': regular plus untagged ones). Precondition: `bars` are native bars,
 * filtered BEFORE any resampling. An untagged native bar (no session, e.g. a cached row stored without one) is kept
 * in 'rth' on purpose, so `undefined` cannot also mean "mixed": `resample` clears `session` on a bucket mixing
 * sessions, and filtering such buckets with 'rth' would wrongly keep them.
 */
export function filterSession(bars: Bar[], mode: SessionMode): Bar[] {
  if (mode === 'eth') return bars.slice();
  return bars.filter((b) => b.session === undefined || b.session === 'regular');
}

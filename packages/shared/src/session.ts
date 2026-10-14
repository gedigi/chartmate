import type { Bar, Session, SessionMode } from './types.js';
import { nyParts } from './nytime.js';

/** Explicit session window, [start, end) in UTC epoch ms. */
export interface SessionWindow { start: number; end: number; session: Session }

/** NY: 04:00–09:30 pre, 09:30–16:00 regular, 16:00–20:00 post, else null. */
export function tagSessionFixedHours(ts: number): Session | null {
  const p = nyParts(ts);
  const min = p.hh * 60 + p.mm;
  if (min >= 240 && min < 570) return 'pre';
  if (min >= 570 && min < 960) return 'regular';
  if (min >= 960 && min < 1200) return 'post';
  return null;
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
  const out: Bar[] = [];
  for (const bar of bars) {
    const w = segs.length > 0 ? findSegment(segs, bar.ts) : undefined;
    const session = w ? w.session : tagSessionFixedHours(bar.ts);
    if (session) out.push({ ...bar, session });
  }
  return out;
}

export function filterSession(bars: Bar[], mode: SessionMode): Bar[] {
  if (mode === 'eth') return bars.slice();
  return bars.filter((b) => b.session === undefined || b.session === 'regular');
}

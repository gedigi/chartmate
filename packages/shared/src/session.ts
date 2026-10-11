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

/** Returns new bars with `session` set; windows win over fixed hours; bars in no session are dropped. */
export function tagSessions(bars: Bar[], windows?: SessionWindow[]): Bar[] {
  const out: Bar[] = [];
  for (const bar of bars) {
    const w = windows?.find((x) => bar.ts >= x.start && bar.ts < x.end);
    const session = w ? w.session : tagSessionFixedHours(bar.ts);
    if (session) out.push({ ...bar, session });
  }
  return out;
}

export function filterSession(bars: Bar[], mode: SessionMode): Bar[] {
  if (mode === 'eth') return bars.slice();
  return bars.filter((b) => b.session === undefined || b.session === 'regular');
}

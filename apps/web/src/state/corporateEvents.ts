import type { CorporateEvent, SymbolId } from '@chartmate/shared';
import { api } from '../api/client';

/** Corporate events change rarely: a symbol's answer is reused for an hour (the server caches them longer). */
export const EVENTS_TTL_MS = 60 * 60_000;
const MAX_SYMBOLS = 100;

const cache = new Map<SymbolId, { at: number; events: CorporateEvent[] }>();
const pending = new Map<SymbolId, Promise<CorporateEvent[]>>();

/** A stock's earnings, dividends and splits (cached for EVENTS_TTL_MS; concurrent calls share one request). */
export function corporateEvents(id: SymbolId, now: () => number = Date.now): Promise<CorporateEvent[]> {
  const hit = cache.get(id);
  if (hit && now() - hit.at < EVENTS_TTL_MS) return Promise.resolve(hit.events);
  const inFlight = pending.get(id);
  if (inFlight) return inFlight;
  const p = api.events(id).then((r) => {
    cache.delete(id);
    cache.set(id, { at: now(), events: r.events });
    while (cache.size > MAX_SYMBOLS) cache.delete(cache.keys().next().value!);
    return r.events;
  }).finally(() => { pending.delete(id); });
  pending.set(id, p);
  return p;
}

/** Tests only. */
export function resetCorporateEvents(): void {
  cache.clear();
  pending.clear();
}

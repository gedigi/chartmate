import type { Quote, SymbolId } from '@chartmate/shared';

/**
 * The latest quotes the page has fetched (the watchlist polls them every 15 s), shared so another view of the same
 * symbol (the detail panel) reads them instead of polling again. In-memory, per page.
 */
const quotes = new Map<SymbolId, { quote: Quote; at: number }>();
const listeners = new Set<() => void>();

export function publishQuotes(list: readonly Quote[], now = Date.now()): void {
  if (list.length === 0) return;
  for (const q of list) quotes.set(q.id, { quote: q, at: now });
  for (const l of listeners) l();
}

/** The quote of `id` fetched within `maxAgeMs`, else undefined. */
export function cachedQuote(id: SymbolId, maxAgeMs: number, now = Date.now()): Quote | undefined {
  const hit = quotes.get(id);
  return hit && now - hit.at <= maxAgeMs ? hit.quote : undefined;
}

/** The last quote of `id` whatever its age. */
export function lastQuote(id: SymbolId): Quote | undefined {
  return quotes.get(id)?.quote;
}

export function subscribeQuotes(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests only. */
export function clearQuotes(): void {
  quotes.clear();
}

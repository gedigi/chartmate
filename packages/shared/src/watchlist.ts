import { tryNormalizeSymbolId, type SymbolId } from './types.js';

/**
 * One row of the watchlist. The list is an ordered sequence of symbols and section headers: the symbols below a
 * header belong to that section until the next header; symbols before the first header form an untitled top group.
 */
export type WatchlistEntry =
  | { type: 'symbol'; id: SymbolId }
  | { type: 'section'; id: string; title: string; collapsed: boolean };
export type WatchlistSection = Extract<WatchlistEntry, { type: 'section' }>;

export const MAX_WATCHLIST_SYMBOLS = 200;
/**
 * Response header of `GET /api/watchlist`: `1` when a watchlist was ever saved (even if it is empty now), `0` for a
 * database that never had one. Absent from older servers.
 */
export const WATCHLIST_STORED_HEADER = 'chartmate-watchlist-stored';
export const MAX_WATCHLIST_SECTIONS = 50;
export const MAX_SECTION_TITLE = 40;
const MAX_SECTION_ID = 64;

/** The symbol ids of a watchlist, in order (section headers excluded). */
export function watchlistSymbols(entries: readonly WatchlistEntry[]): SymbolId[] {
  const out: SymbolId[] = [];
  for (const e of entries) if (e.type === 'symbol') out.push(e.id);
  return out;
}

/**
 * Lenient reader for a stored / received watchlist: accepts the legacy `SymbolId[]` shape and the entry shape (also
 * mixed). Symbol ids are normalized (see parseSymbolId); malformed items, repeated symbols (case variants included)
 * and repeated section ids are dropped; titles are trimmed and clipped.
 */
export function normalizeWatchlist(raw: unknown): WatchlistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchlistEntry[] = [];
  const symbols = new Set<string>();
  const sections = new Set<string>();
  const addSymbol = (raw: unknown) => {
    const id = tryNormalizeSymbolId(raw);
    if (id !== null && !symbols.has(id)) { symbols.add(id); out.push({ type: 'symbol', id }); }
  };
  for (const item of raw as unknown[]) {
    if (typeof item === 'string') {
      addSymbol(item);
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (o['type'] === 'symbol') {
      addSymbol(o['id']);
    } else if (o['type'] === 'section') {
      const id = o['id'];
      const title = typeof o['title'] === 'string' ? o['title'].trim().slice(0, MAX_SECTION_TITLE).trim() : '';
      if (typeof id !== 'string' || id === '' || id.length > MAX_SECTION_ID || sections.has(id) || title === '') continue;
      sections.add(id);
      out.push({ type: 'section', id, title, collapsed: o['collapsed'] === true });
    }
  }
  return out;
}

/** Why a (well-formed) entry list is not a valid watchlist, or null when it is. */
export function watchlistProblem(entries: readonly WatchlistEntry[]): string | null {
  const symbols = new Set<string>();
  const sections = new Set<string>();
  for (const e of entries) {
    if (e.type === 'symbol') {
      if (symbols.has(e.id)) return `duplicate symbol ${e.id}`;
      symbols.add(e.id);
    } else {
      if (sections.has(e.id)) return `duplicate section id ${e.id}`;
      sections.add(e.id);
      const t = e.title.trim();
      if (t.length === 0 || e.title.length > MAX_SECTION_TITLE) return `section title must be 1-${MAX_SECTION_TITLE} characters`;
    }
  }
  if (symbols.size > MAX_WATCHLIST_SYMBOLS) return `at most ${MAX_WATCHLIST_SYMBOLS} symbols`;
  if (sections.size > MAX_WATCHLIST_SECTIONS) return `at most ${MAX_WATCHLIST_SECTIONS} sections`;
  return null;
}

/**
 * Applies a legacy `SymbolId[]` save (e.g. from a tab opened before sections existed) to the stored list without
 * losing its sections: stored entries are kept, symbols missing from `ids` are dropped, the remaining symbol slots
 * are refilled in the order `ids` gives, and ids not stored yet are appended. With no stored sections, or an empty
 * `ids`, this is a plain replace.
 */
export function mergeLegacyWatchlist(stored: readonly WatchlistEntry[], ids: readonly SymbolId[]): WatchlistEntry[] {
  const unique = [...new Set(ids)];
  const plain = unique.map((id): WatchlistEntry => ({ type: 'symbol', id }));
  if (unique.length === 0 || !stored.some((e) => e.type === 'section')) return plain;
  const wanted = new Set(unique);
  const kept = stored.filter((e) => e.type === 'section' || wanted.has(e.id));
  const storedIds = new Set(watchlistSymbols(stored));
  const refill = unique.filter((id) => storedIds.has(id));
  let k = 0;
  const out = kept.map((e): WatchlistEntry => (e.type === 'symbol' ? { type: 'symbol', id: refill[k++]! } : e));
  for (const id of unique) if (!storedIds.has(id)) out.push({ type: 'symbol', id });
  return out;
}

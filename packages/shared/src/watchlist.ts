import { parseSymbolId, type SymbolId } from './types.js';

/**
 * One row of the watchlist. The list is an ordered sequence of symbols and section headers: the symbols below a
 * header belong to that section until the next header; symbols before the first header form an untitled top group.
 */
export type WatchlistEntry =
  | { type: 'symbol'; id: SymbolId }
  | { type: 'section'; id: string; title: string; collapsed: boolean };
export type WatchlistSection = Extract<WatchlistEntry, { type: 'section' }>;

export const MAX_WATCHLIST_SYMBOLS = 200;
export const MAX_WATCHLIST_SECTIONS = 50;
export const MAX_SECTION_TITLE = 40;
const MAX_SECTION_ID = 64;

/** The symbol ids of a watchlist, in order (section headers excluded). */
export function watchlistSymbols(entries: readonly WatchlistEntry[]): SymbolId[] {
  const out: SymbolId[] = [];
  for (const e of entries) if (e.type === 'symbol') out.push(e.id);
  return out;
}

function validSymbol(id: unknown): id is SymbolId {
  if (typeof id !== 'string' || id.length > 100) return false;
  try { parseSymbolId(id); return true; } catch { return false; }
}

/**
 * Lenient reader for a stored / received watchlist: accepts the legacy `SymbolId[]` shape and the entry shape (also
 * mixed). Malformed items, repeated symbols and repeated section ids are dropped; titles are trimmed and clipped.
 */
export function normalizeWatchlist(raw: unknown): WatchlistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchlistEntry[] = [];
  const symbols = new Set<string>();
  const sections = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item === 'string') {
      if (validSymbol(item) && !symbols.has(item)) { symbols.add(item); out.push({ type: 'symbol', id: item }); }
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (o['type'] === 'symbol') {
      const id = o['id'];
      if (validSymbol(id) && !symbols.has(id)) { symbols.add(id); out.push({ type: 'symbol', id }); }
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

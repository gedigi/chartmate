import type { SymbolId, WatchlistEntry, WatchlistSection } from '@altv/shared';

/**
 * Pure operations on the watchlist entry list (symbols and section headers). A symbol belongs to the closest header
 * above it; symbols above the first header form the untitled top group (section `null`). Operations return the same
 * array when nothing changes, so an unchanged list is never saved.
 */

export type Entries = readonly WatchlistEntry[];

/** Section id of the entry at `index` (a header belongs to its own section); null for the top group. */
export function sectionIdAt(entries: Entries, index: number): string | null {
  for (let i = Math.min(index, entries.length - 1); i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'section') return e.id;
  }
  return null;
}

function headerIndex(entries: Entries, sectionId: string): number {
  return entries.findIndex((e) => e.type === 'section' && e.id === sectionId);
}

/** Index just past the last entry of the section whose header is at `header`. */
function blockEnd(entries: Entries, header: number): number {
  let i = header + 1;
  while (i < entries.length && entries[i]!.type !== 'section') i++;
  return i;
}

export function setCollapsed(entries: Entries, sectionId: string, collapsed: boolean): WatchlistEntry[] {
  const i = headerIndex(entries, sectionId);
  const e = entries[i];
  if (!e || e.type !== 'section' || e.collapsed === collapsed) return entries as WatchlistEntry[];
  const next = entries.slice();
  next[i] = { ...e, collapsed };
  return next;
}

/** Section of every symbol (null = top group). */
function membership(entries: Entries): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let section: string | null = null;
  for (const e of entries) {
    if (e.type === 'section') section = e.id;
    else out.set(e.id, section);
  }
  return out;
}

/**
 * Expands every collapsed section of `after` that gained a symbol compared to `before`, so a header delete / move
 * never hides a symbol that was visible.
 */
function expandGainers(before: Entries, after: WatchlistEntry[]): WatchlistEntry[] {
  const was = membership(before);
  let next = after;
  for (const [id, section] of membership(after)) {
    if (section !== null && was.get(id) !== section) next = setCollapsed(next, section, false);
  }
  return next;
}

function expand(entries: Entries, sectionId: string | null): WatchlistEntry[] {
  return sectionId === null ? (entries as WatchlistEntry[]) : setCollapsed(entries, sectionId, false);
}

/**
 * Adds a symbol at the end of section `sectionId` (expanded so the new row is visible), or at the end of the list
 * when there is no such section. A symbol already in the list is ignored.
 */
export function addSymbol(entries: Entries, id: SymbolId, sectionId: string | null): WatchlistEntry[] {
  if (entries.some((e) => e.type === 'symbol' && e.id === id)) return entries as WatchlistEntry[];
  const entry: WatchlistEntry = { type: 'symbol', id };
  const h = sectionId === null ? -1 : headerIndex(entries, sectionId);
  if (h < 0) return [...entries, entry];
  const next = expand(entries, sectionId).slice();
  next.splice(blockEnd(next, h), 0, entry);
  return next;
}

export function removeSymbol(entries: Entries, id: SymbolId): WatchlistEntry[] {
  const i = entries.findIndex((e) => e.type === 'symbol' && e.id === id);
  return i < 0 ? (entries as WatchlistEntry[]) : entries.filter((_, j) => j !== i);
}

export function insertSection(entries: Entries, at: number, section: WatchlistSection): WatchlistEntry[] {
  const next = entries.slice();
  next.splice(Math.max(0, Math.min(at, next.length)), 0, section);
  return next;
}

export function renameSection(entries: Entries, sectionId: string, title: string): WatchlistEntry[] {
  const i = headerIndex(entries, sectionId);
  const e = entries[i];
  if (!e || e.type !== 'section' || e.title === title) return entries as WatchlistEntry[];
  const next = entries.slice();
  next[i] = { ...e, title };
  return next;
}

/** Removes only the header: its symbols join the previous section (expanded if collapsed, so they stay visible). */
export function deleteSection(entries: Entries, sectionId: string): WatchlistEntry[] {
  const i = headerIndex(entries, sectionId);
  return i < 0 ? (entries as WatchlistEntry[]) : expandGainers(entries, entries.filter((_, j) => j !== i));
}

function splice(entries: Entries, from: number, to: number): WatchlistEntry[] {
  const next = entries.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Keyboard move (Alt+↑/↓) of the entry at `index` by one row. A header moves alone (its symbols stay in place).
 * Collapsed sections involved are expanded first, so the moved row stays visible and keeps focus.
 */
export function moveByKey(entries: Entries, index: number, dir: -1 | 1): WatchlistEntry[] {
  const to = index + dir;
  if (index < 0 || index >= entries.length || to < 0 || to >= entries.length) return entries as WatchlistEntry[];
  let next = expand(entries, sectionIdAt(entries, index));
  next = expand(next, sectionIdAt(next, to));
  next = splice(next, index, to);
  return expandGainers(entries, next);
}

/**
 * Drag and drop of the entry at `from` onto the row of the entry at `to` (splice semantics: moving down lands after
 * the target, moving up before it). Dropping a symbol onto a collapsed header appends it to that section, which stays
 * collapsed; a header dropped onto a collapsed header from above lands after that whole section. A moved collapsed
 * header is expanded (it moves alone, so its symbols become part of the section above), and so is any other collapsed
 * section that gains symbols.
 */
export function dropEntry(entries: Entries, from: number, to: number): WatchlistEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return entries as WatchlistEntry[];
  const moved = entries[from]!;
  const target = entries[to]!;
  if (target.type === 'section' && target.collapsed && (moved.type === 'symbol' || from < to)) {
    const without = entries.filter((_, j) => j !== from);
    const h = headerIndex(without, target.id);
    const next = without.slice();
    if (moved.type === 'symbol') {
      next.splice(blockEnd(without, h), 0, moved); // explicit drop into a collapsed section: it stays collapsed
      return next;
    }
    next.splice(blockEnd(without, h), 0, { ...moved, collapsed: false });
    return expandGainers(entries, next);
  }
  let next = moved.type === 'section' ? setCollapsed(entries, moved.id, false) : (entries as WatchlistEntry[]);
  next = splice(next, from, to);
  return expandGainers(entries, next);
}

export interface WatchlistRow {
  entry: WatchlistEntry;
  /** Index in the entry list. */
  index: number;
  /** Section the row belongs to (a header: its own); null for the top group. */
  sectionId: string | null;
  /** Headers: number of symbols in the section. */
  count?: number;
}

/** The rows to render: everything except the symbols of collapsed sections. */
export function visibleRows(entries: Entries): WatchlistRow[] {
  const rows: WatchlistRow[] = [];
  let section: string | null = null;
  let collapsed = false;
  let header: WatchlistRow | null = null;
  entries.forEach((entry, index) => {
    if (entry.type === 'section') {
      section = entry.id;
      collapsed = entry.collapsed;
      header = { entry, index, sectionId: entry.id, count: 0 };
      rows.push(header);
      return;
    }
    if (header) header.count!++;
    if (!collapsed) rows.push({ entry, index, sectionId: section });
  });
  return rows;
}

/** A random RFC 4122 v4 uuid (works without a secure context, unlike `crypto.randomUUID`). */
export function newSectionId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

import type { WatchlistEntry, WatchlistSection } from '@altv/shared';
import { describe, expect, it } from 'vitest';
import {
  addSymbol, deleteSection, dropEntry, insertSection, moveByKey, newSectionId, removeSymbol, renameSection, sectionIdAt,
  setCollapsed, visibleRows,
} from '../src/state/watchlistModel';

const s = (id: string): WatchlistEntry => ({ type: 'symbol', id: `stock:${id}` });
const h = (id: string, collapsed = false): WatchlistEntry => ({ type: 'section', id, title: id.toUpperCase(), collapsed });
/** Compact notation: symbols as their ticker, headers as `#id` (`#id-` when collapsed). */
const show = (list: WatchlistEntry[]) =>
  list.map((e) => (e.type === 'symbol' ? e.id.slice(6) : `#${e.id}${e.collapsed ? '-' : ''}`)).join(' ');

describe('watchlist model', () => {
  const base = [s('A'), h('x'), s('B'), s('C'), h('y'), s('D')];

  it('sectionIdAt: top group is null; a header belongs to its own section', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => sectionIdAt(base, i))).toEqual([null, 'x', 'x', 'x', 'y', 'y']);
  });

  it('addSymbol appends to the end of the active section, else the end of the list; duplicates ignored', () => {
    expect(show(addSymbol(base, 'stock:E', 'x'))).toBe('A #x B C E #y D');
    expect(show(addSymbol(base, 'stock:E', 'y'))).toBe('A #x B C #y D E');
    expect(show(addSymbol(base, 'stock:E', null))).toBe('A #x B C #y D E');
    expect(show(addSymbol(base, 'stock:E', 'gone'))).toBe('A #x B C #y D E');
    expect(addSymbol(base, 'stock:B', 'y')).toBe(base);
  });

  it('adding into a collapsed section expands it', () => {
    expect(show(addSymbol([h('x', true), s('A')], 'stock:E', 'x'))).toBe('#x A E');
  });

  it('removeSymbol / renameSection / deleteSection / setCollapsed', () => {
    expect(show(removeSymbol(base, 'stock:C'))).toBe('A #x B #y D');
    expect(removeSymbol(base, 'stock:Z')).toBe(base);
    const renamed = renameSection(base, 'x', 'Tech');
    expect(renamed[1]).toEqual({ type: 'section', id: 'x', title: 'Tech', collapsed: false });
    expect(show(deleteSection(base, 'x'))).toBe('A B C #y D');
    expect(show(setCollapsed(base, 'y', true))).toBe('A #x B C #y- D');
    expect(setCollapsed(base, 'y', false)).toBe(base);
  });

  it('insertSection inserts a header at an index', () => {
    expect(show(insertSection(base, 4, h('n') as WatchlistSection))).toBe('A #x B C #n #y D');
  });

  it('newSectionId is a v4 uuid and unique', () => {
    const a = newSectionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newSectionId()).not.toBe(a);
  });

  it('visibleRows hides symbols of collapsed sections and counts them on the header', () => {
    const rows = visibleRows([s('A'), h('x', true), s('B'), s('C'), h('y'), s('D')]);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 4, 5]);
    expect(rows[1]!.count).toBe(2);
    expect(rows[2]!.count).toBe(1);
    expect(rows.map((r) => r.sectionId)).toEqual([null, 'x', 'y', 'y']);
  });

  it('moveByKey moves symbols across section boundaries one row at a time', () => {
    let l = base;
    l = moveByKey(l, 2, -1); // B up past header x → top group
    expect(show(l)).toBe('A B #x C #y D');
    l = moveByKey(l, 3, 1); // C down past header y → first in y
    expect(show(l)).toBe('A B #x #y C D');
    expect(moveByKey(l, 0, -1)).toBe(l);
    expect(moveByKey(l, l.length - 1, 1)).toBe(l);
  });

  it('moveByKey moves a header row only', () => {
    expect(show(moveByKey(base, 4, -1))).toBe('A #x B #y C D');
    expect(show(moveByKey(base, 1, 1))).toBe('A B #x C #y D');
  });

  it('moveByKey expands collapsed sections it moves into, and a moved collapsed header', () => {
    expect(show(moveByKey([s('A'), h('x', true), s('B')], 0, 1))).toBe('#x A B');
    expect(show(moveByKey([h('x', true), s('B'), h('y'), s('C')], 3, -1))).toBe('#x B C #y');
    expect(show(moveByKey([h('x', true), s('B'), h('y'), s('C')], 2, -1))).toBe('#x #y B C');
    expect(show(moveByKey([s('A'), h('x', true), s('B')], 1, -1))).toBe('#x A B');
  });

  it('dropEntry reorders like a splice (down: after the target, up: before it)', () => {
    expect(show(dropEntry(base, 0, 3))).toBe('#x B C A #y D');
    expect(show(dropEntry(base, 5, 2))).toBe('A #x D B C #y');
    expect(show(dropEntry(base, 4, 1))).toBe('A #y #x B C D');
    expect(dropEntry(base, 2, 2)).toBe(base);
  });

  it('dropEntry onto a collapsed header appends into that (still collapsed) section', () => {
    const l = [s('A'), h('x', true), s('B'), h('y'), s('C')];
    expect(show(dropEntry(l, 0, 1))).toBe('#x- B A #y C');
    expect(show(dropEntry(l, 4, 1))).toBe('A #x- B C #y');
  });

  it('dropping a header onto a collapsed header from above lands after its whole section', () => {
    const l = [h('y'), s('A'), h('x', true), s('B'), s('C')];
    expect(show(dropEntry(l, 0, 2))).toBe('A #x- B C #y');
  });
});

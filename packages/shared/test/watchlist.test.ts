import { describe, it, expect } from 'vitest';
import {
  MAX_SECTION_TITLE, MAX_WATCHLIST_SECTIONS, MAX_WATCHLIST_SYMBOLS, normalizeWatchlist, watchlistProblem, watchlistSymbols,
  type WatchlistEntry,
} from '../src/watchlist.js';

const sec = (id: string, title = 'S', collapsed = false): WatchlistEntry => ({ type: 'section', id, title, collapsed });
const sym = (id: string): WatchlistEntry => ({ type: 'symbol', id });
const UUID_A = '0b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60';
const UUID_B = '1b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f61';

describe('watchlist entries', () => {
  it('watchlistSymbols keeps only symbol ids, in order', () => {
    expect(watchlistSymbols([sym('stock:A'), sec(UUID_A), sym('crypto:B')])).toEqual(['stock:A', 'crypto:B']);
  });

  it('normalizeWatchlist converts a legacy symbol id array', () => {
    expect(normalizeWatchlist(['stock:A', 'crypto:B'])).toEqual([sym('stock:A'), sym('crypto:B')]);
  });

  it('normalizeWatchlist keeps entries; drops malformed ones, duplicate symbols and duplicate section ids', () => {
    const raw = [sym('stock:A'), sec(UUID_A, 'Tech', true), 'crypto:B', { type: 'section', id: UUID_A, title: 'dup', collapsed: false },
      sym('stock:A'), { type: 'symbol', id: 'bogus' }, { type: 'section', id: UUID_B, title: '   ', collapsed: false }, 42, null];
    expect(normalizeWatchlist(raw)).toEqual([sym('stock:A'), sec(UUID_A, 'Tech', true), sym('crypto:B')]);
  });

  it('normalizeWatchlist: non-array → empty; long titles are clipped, titles trimmed, collapsed coerced', () => {
    expect(normalizeWatchlist({ nope: 1 })).toEqual([]);
    const long = 'x'.repeat(60);
    expect(normalizeWatchlist([{ type: 'section', id: UUID_A, title: ` ${long} `, collapsed: 'yes' }]))
      .toEqual([sec(UUID_A, 'x'.repeat(MAX_SECTION_TITLE), false)]);
  });

  it('watchlistProblem accepts a valid list and reports each limit', () => {
    expect(watchlistProblem([sym('stock:A'), sec(UUID_A, 'Tech'), sym('crypto:B')])).toBeNull();
    expect(watchlistProblem([sym('stock:A'), sym('stock:A')])).toMatch(/duplicate symbol/);
    expect(watchlistProblem([sec(UUID_A), sec(UUID_A)])).toMatch(/duplicate section/);
    expect(watchlistProblem([sec(UUID_A, '')])).toMatch(/title/);
    expect(watchlistProblem([sec(UUID_A, '  ')])).toMatch(/title/);
    expect(watchlistProblem([sec(UUID_A, 'x'.repeat(MAX_SECTION_TITLE + 1))])).toMatch(/title/);
    expect(watchlistProblem([sec(UUID_A, 'x'.repeat(MAX_SECTION_TITLE))])).toBeNull();
    const many = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 1 }, (_, i) => sym(`stock:S${i}`));
    expect(watchlistProblem(many)).toMatch(/symbols/);
    expect(watchlistProblem(many.slice(1))).toBeNull();
    const secs = Array.from({ length: MAX_WATCHLIST_SECTIONS + 1 }, (_, i) => sec(`${String(i).padStart(8, '0')}-3f1a-4c1e-9a7b-2a1d3c4e5f60`));
    expect(watchlistProblem(secs)).toMatch(/sections/);
    expect(watchlistProblem(secs.slice(1))).toBeNull();
  });
});

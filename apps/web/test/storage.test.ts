import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from '../src/state/storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('localStorage keys (chartmate.*)', () => {
  it('reads the chartmate.* key', () => {
    localStorage.setItem('chartmate.theme', 'light');
    expect(readStored('theme')).toBe('light');
    expect(readStored('missing')).toBeNull();
  });

  it('writes the chartmate.* key', () => {
    writeStored('watchlist.initialized', '1');
    expect(localStorage.getItem('chartmate.watchlist.initialized')).toBe('1');
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStored('theme')).toBeNull();
    expect(() => writeStored('theme', 'dark')).not.toThrow();
  });
});

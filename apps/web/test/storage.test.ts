import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyStorage, readStored, writeStored } from '../src/state/storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const all = () => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
};

describe('localStorage keys (chartmate.*, migrating legacy altv.*)', () => {
  it('reads the new key', () => {
    localStorage.setItem('chartmate.theme', 'light');
    expect(readStored('theme')).toBe('light');
    expect(readStored('missing')).toBeNull();
  });

  it('falls back to the legacy key and moves it', () => {
    localStorage.setItem('altv.theme', 'light');
    expect(readStored('theme')).toBe('light');
    expect(all()).toEqual({ 'chartmate.theme': 'light' });
  });

  it('prefers the new key when both exist', () => {
    localStorage.setItem('chartmate.theme', 'dark');
    localStorage.setItem('altv.theme', 'light');
    expect(readStored('theme')).toBe('dark');
  });

  it('writes the new key and removes the legacy one', () => {
    localStorage.setItem('altv.watchlist.initialized', '1');
    writeStored('watchlist.initialized', '1');
    expect(all()).toEqual({ 'chartmate.watchlist.initialized': '1' });
  });

  it('migrates every altv.* key at startup without overwriting newer values', () => {
    localStorage.setItem('altv.theme', 'light');
    localStorage.setItem('altv.watchlist.initialized', '1');
    localStorage.setItem('altv.someOtherKey', 'old');
    localStorage.setItem('chartmate.someOtherKey', 'kept');
    localStorage.setItem('unrelated', 'u');
    migrateLegacyStorage();
    expect(all()).toEqual({
      'chartmate.theme': 'light', 'chartmate.watchlist.initialized': '1', 'chartmate.someOtherKey': 'kept', unrelated: 'u',
    });
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStored('theme')).toBeNull();
    expect(() => writeStored('theme', 'dark')).not.toThrow();
    expect(() => migrateLegacyStorage()).not.toThrow();
  });
});

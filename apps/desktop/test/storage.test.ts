import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync as moveFileForTest, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensurePrivateDir, migrateLegacyUserData, restrictFiles } from '../src/lib/storage.js';

const posix = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'chartmate-storage-'));
});

describe('ensurePrivateDir', () => {
  it.runIf(posix)('creates nested directories owner-only (0700)', () => {
    const dir = join(base, 'a', 'b');
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it.runIf(posix)('tightens an existing permissive directory', () => {
    const dir = join(base, 'open');
    mkdirSync(dir, { mode: 0o755 });
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });
});

describe('restrictFiles', () => {
  it.runIf(posix)('chmods existing files to 0600 and ignores missing ones', () => {
    const f = join(base, 'chartmate.db');
    writeFileSync(f, 'x', { mode: 0o644 });
    restrictFiles([f, join(base, 'chartmate.db-wal')]);
    expect(mode(f)).toBe(0o600);
    expect(existsSync(join(base, 'chartmate.db-wal'))).toBe(false);
  });
});

describe('migrateLegacyUserData', () => {
  const files = ['chartmate.db', 'chartmate.db-wal', 'chartmate.db-shm', 'window-state.json'];

  it('moves the database (and its WAL/SHM) from the first legacy dir that has one', () => {
    const old1 = join(base, 'Old Empty');
    const old2 = join(base, 'Old Name');
    const target = join(base, 'New Name');
    mkdirSync(old1);
    mkdirSync(old2);
    writeFileSync(join(old2, 'chartmate.db'), 'db');
    writeFileSync(join(old2, 'chartmate.db-wal'), 'wal');
    writeFileSync(join(old2, 'window-state.json'), '{}');
    const from = migrateLegacyUserData({ target, legacyDirs: [old1, old2], files, marker: 'chartmate.db' });
    expect(from).toBe(old2);
    expect(readFileSync(join(target, 'chartmate.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(target, 'chartmate.db-wal'), 'utf8')).toBe('wal');
    expect(existsSync(join(target, 'window-state.json'))).toBe(true);
    expect(existsSync(join(old2, 'chartmate.db'))).toBe(false);
  });

  it('moves the marker database last, so an interrupted migration is retried on the next launch', () => {
    const old = join(base, 'Old Name');
    const target = join(base, 'New Name');
    mkdirSync(old);
    writeFileSync(join(old, 'chartmate.db'), 'db');
    writeFileSync(join(old, 'chartmate.db-wal'), 'wal');
    writeFileSync(join(old, 'chartmate.db-shm'), 'shm');
    const order: string[] = [];
    // First launch: the move of the SHM file fails (e.g. a locked file, a full disk).
    const failing = (from: string, to: string) => {
      order.push(from.slice(old.length + 1));
      if (from.endsWith('-shm')) throw new Error('EBUSY');
      moveFileForTest(from, to);
    };
    expect(() => migrateLegacyUserData({ target, legacyDirs: [old], files, marker: 'chartmate.db', move: failing })).toThrow('EBUSY');
    expect(order).not.toContain('chartmate.db');
    expect(existsSync(join(target, 'chartmate.db'))).toBe(false); // no marker: not considered migrated
    expect(readFileSync(join(old, 'chartmate.db'), 'utf8')).toBe('db');

    // Next launch: the migration completes, nothing is lost.
    expect(migrateLegacyUserData({ target, legacyDirs: [old], files, marker: 'chartmate.db' })).toBe(old);
    for (const [f, v] of [['chartmate.db', 'db'], ['chartmate.db-wal', 'wal'], ['chartmate.db-shm', 'shm']] as const) {
      expect(readFileSync(join(target, f), 'utf8')).toBe(v);
      expect(existsSync(join(old, f))).toBe(false);
    }
  });

  it('never overwrites an existing database in the target', () => {
    const old = join(base, 'Old');
    const target = join(base, 'New');
    mkdirSync(old);
    mkdirSync(target);
    writeFileSync(join(old, 'chartmate.db'), 'old');
    writeFileSync(join(target, 'chartmate.db'), 'current');
    expect(migrateLegacyUserData({ target, legacyDirs: [old], files, marker: 'chartmate.db' })).toBeNull();
    expect(readFileSync(join(target, 'chartmate.db'), 'utf8')).toBe('current');
    expect(readFileSync(join(old, 'chartmate.db'), 'utf8')).toBe('old');
  });

  it('is a no-op without legacy data, and ignores the target listed as its own legacy dir', () => {
    const target = join(base, 'Same');
    mkdirSync(target);
    expect(migrateLegacyUserData({ target, legacyDirs: [target, join(base, 'missing')], files, marker: 'chartmate.db' })).toBeNull();
  });

  it.runIf(posix)('creates the target owner-only and leaves migrated files 0600', () => {
    const old = join(base, 'Old');
    mkdirSync(old);
    writeFileSync(join(old, 'chartmate.db'), 'db', { mode: 0o644 });
    const target = join(base, 'New');
    migrateLegacyUserData({ target, legacyDirs: [old], files, marker: 'chartmate.db' });
    expect(mode(target)).toBe(0o700);
    expect(mode(join(target, 'chartmate.db'))).toBe(0o600);
  });
});

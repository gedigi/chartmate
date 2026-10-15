import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_SETTINGS, loadUpdateSettings, MAX_SETTINGS_BYTES, parseUpdateSettings, saveUpdateSettings, UPDATE_SETTINGS_FILE,
} from '../src/lib/updateSettings.js';

const dir = () => mkdtempSync(join(tmpdir(), 'update-settings-'));

describe('parseUpdateSettings (strict schema)', () => {
  it('accepts exactly { checkAutomatically: boolean }', () => {
    expect(parseUpdateSettings({ checkAutomatically: false })).toEqual({ checkAutomatically: false });
    expect(parseUpdateSettings({ checkAutomatically: true })).toEqual({ checkAutomatically: true });
  });
  it('rejects anything else as a whole', () => {
    for (const raw of [
      null, 1, 'x', [], [false], {}, { checkAutomatically: 'false' }, { checkAutomatically: 0 },
      { checkAutomatically: true, extra: 1 }, { __proto__: { checkAutomatically: true } },
      JSON.parse('{"checkAutomatically":true,"__proto__":{"x":1}}'),
    ]) {
      expect(parseUpdateSettings(raw)).toBeNull();
    }
  });
});

describe('loadUpdateSettings', () => {
  it('defaults to checking automatically when the file is missing', () => {
    expect(DEFAULT_UPDATE_SETTINGS).toEqual({ checkAutomatically: true });
    expect(loadUpdateSettings(dir())).toEqual({ checkAutomatically: true });
  });
  it('reads a saved file and falls back to the defaults for an invalid one', () => {
    const d = dir();
    const problems: string[] = [];
    writeFileSync(join(d, UPDATE_SETTINGS_FILE), '{"checkAutomatically":false}');
    expect(loadUpdateSettings(d)).toEqual({ checkAutomatically: false });
    for (const body of ['not json', '{"checkAutomatically":"no"}', '{"checkAutomatically":false,"x":1}', '[]']) {
      writeFileSync(join(d, UPDATE_SETTINGS_FILE), body);
      expect(loadUpdateSettings(d, (p) => problems.push(p))).toEqual(DEFAULT_UPDATE_SETTINGS);
    }
    expect(problems).toHaveLength(4);
  });
  it('refuses an oversized file without parsing it', () => {
    const d = dir();
    writeFileSync(join(d, UPDATE_SETTINGS_FILE), `{"checkAutomatically":false${' '.repeat(MAX_SETTINGS_BYTES)}}`);
    expect(loadUpdateSettings(d)).toEqual(DEFAULT_UPDATE_SETTINGS);
  });
  it.runIf(process.platform !== 'win32')('refuses a FIFO without blocking on it', () => {
    const d = dir();
    execFileSync('mkfifo', [join(d, UPDATE_SETTINGS_FILE)]);
    const problems: string[] = [];
    expect(loadUpdateSettings(d, (p) => problems.push(p))).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(problems.join()).toMatch(/not a regular file/);
  });
  it('reads through a single descriptor (open with O_NOFOLLOW, then fstat), not lstat-then-read', () => {
    const src = readFileSync(new URL('../src/lib/updateSettings.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/O_NOFOLLOW/);
    expect(src).toMatch(/O_NONBLOCK/);
    expect(src).toMatch(/fstatSync\(fd\)/);
    expect(src).not.toMatch(/readFileSync\(file/);
  });
  it.runIf(process.platform !== 'win32')('refuses a symlink (never reads a file elsewhere)', () => {
    const d = dir();
    const other = join(dir(), 'elsewhere.json');
    writeFileSync(other, '{"checkAutomatically":false}');
    symlinkSync(other, join(d, UPDATE_SETTINGS_FILE));
    expect(loadUpdateSettings(d)).toEqual(DEFAULT_UPDATE_SETTINGS);
  });
});

describe('saveUpdateSettings', () => {
  it('writes atomically to the fixed file name, owner-only, leaving no temp files', () => {
    const d = dir();
    expect(saveUpdateSettings(d, { checkAutomatically: false })).toBe(true);
    expect(readdirSync(d)).toEqual([UPDATE_SETTINGS_FILE]);
    expect(JSON.parse(readFileSync(join(d, UPDATE_SETTINGS_FILE), 'utf8'))).toEqual({ checkAutomatically: false });
    if (process.platform !== 'win32') expect(statSync(join(d, UPDATE_SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    expect(saveUpdateSettings(d, { checkAutomatically: true })).toBe(true);
    expect(loadUpdateSettings(d)).toEqual({ checkAutomatically: true });
  });
  it('writes only the known field', () => {
    const d = dir();
    saveUpdateSettings(d, { checkAutomatically: false, injected: '<b>x</b>' } as never);
    expect(readFileSync(join(d, UPDATE_SETTINGS_FILE), 'utf8')).toBe('{"checkAutomatically":false}');
  });
  it.runIf(process.platform !== 'win32')('replaces a planted symlink instead of writing through it', () => {
    const d = dir();
    const other = join(dir(), 'victim.txt');
    writeFileSync(other, 'keep');
    symlinkSync(other, join(d, UPDATE_SETTINGS_FILE));
    expect(saveUpdateSettings(d, { checkAutomatically: false })).toBe(true);
    expect(readFileSync(other, 'utf8')).toBe('keep');
    expect(lstatSync(join(d, UPDATE_SETTINGS_FILE)).isSymbolicLink()).toBe(false);
  });
  it('returns false (and never throws) when the directory is unusable', () => {
    expect(saveUpdateSettings(join(dir(), 'missing', 'deeper'), { checkAutomatically: true })).toBe(false);
  });
});

import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * The persisted "Check for updates automatically" choice: `<userData>/update-settings.json`. The file name is fixed
 * (callers pass only the directory), the schema is strict (exactly one boolean), reads refuse anything that is not a
 * small regular file (no symlinks), and writes are atomic and owner-only. Anything invalid falls back to the
 * defaults; nothing here ever throws.
 */
export const UPDATE_SETTINGS_FILE = 'update-settings.json';
export const MAX_SETTINGS_BYTES = 1024;

export interface UpdateSettings {
  checkAutomatically: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: Readonly<UpdateSettings> = Object.freeze({ checkAutomatically: true });

/** Exactly `{ "checkAutomatically": <boolean> }` (own keys only), or null. */
export function parseUpdateSettings(raw: unknown): UpdateSettings | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 1 || keys[0] !== 'checkAutomatically') return null;
  const v = (raw as Record<string, unknown>).checkAutomatically;
  return typeof v === 'boolean' ? { checkAutomatically: v } : null;
}

export function loadUpdateSettings(dir: string, onInvalid?: (problem: string) => void): UpdateSettings {
  const file = join(dir, UPDATE_SETTINGS_FILE);
  let text: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) {
      onInvalid?.('update settings: not a regular file, using defaults');
      return { ...DEFAULT_UPDATE_SETTINGS };
    }
    if (st.size > MAX_SETTINGS_BYTES) {
      onInvalid?.('update settings: file too large, using defaults');
      return { ...DEFAULT_UPDATE_SETTINGS };
    }
    text = readFileSync(file, 'utf8');
  } catch {
    return { ...DEFAULT_UPDATE_SETTINGS }; // missing (first run) or unreadable
  }
  let parsed: UpdateSettings | null = null;
  try {
    parsed = parseUpdateSettings(JSON.parse(text));
  } catch { /* invalid JSON */ }
  if (!parsed) {
    onInvalid?.('update settings: invalid file, using defaults');
    return { ...DEFAULT_UPDATE_SETTINGS };
  }
  return parsed;
}

/**
 * Atomic, owner-only write: a fresh temp file in the same directory (exclusive create, 0600, fsync), then rename over
 * the target. rename replaces a planted symlink rather than writing through it. Returns false on any failure.
 */
export function saveUpdateSettings(dir: string, settings: UpdateSettings): boolean {
  const file = join(dir, UPDATE_SETTINGS_FILE);
  const tmp = join(dir, `.${UPDATE_SETTINGS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  const body = JSON.stringify({ checkAutomatically: settings.checkAutomatically === true });
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (fd !== null) closeSync(fd);
    } catch { /* ignore */ }
    rmSync(tmp, { force: true });
    return false;
  }
}

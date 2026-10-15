import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * The persisted "Check for Updates Automatically" (macOS menu) choice: `<userData>/update-settings.json`. The file
 * name is fixed (callers pass only the directory), the schema is strict (exactly one boolean), reads refuse anything that is not a
 * small regular file (no symlinks, no FIFOs), and writes are atomic and owner-only. Anything invalid falls back to the
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

/**
 * Reads through one descriptor: opened with O_NOFOLLOW (a symlink fails to open) and O_NONBLOCK (a FIFO cannot
 * block the startup), then fstat on that same descriptor, so what is checked is what is read. Windows has neither
 * flag; there an lstat first refuses links (junctions/symlinks need privileges to plant in the user's own profile).
 */
function readSettingsFile(file: string, onInvalid?: (problem: string) => void): string | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants as Record<string, number | undefined>;
  if (O_NOFOLLOW === undefined) {
    try {
      if (!lstatSync(file).isFile()) {
        onInvalid?.('update settings: not a regular file, using defaults');
        return null;
      }
    } catch {
      return null;
    }
  }
  let fd: number;
  try {
    fd = openSync(file, (O_RDONLY ?? 0) | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  } catch (err) {
    // Missing (first run) is normal; a symlink fails with ELOOP (or EMLINK on some systems).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') onInvalid?.('update settings: not a regular file, using defaults');
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      onInvalid?.('update settings: not a regular file, using defaults');
      return null;
    }
    if (st.size > MAX_SETTINGS_BYTES) {
      onInvalid?.('update settings: file too large, using defaults');
      return null;
    }
    const buf = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_SETTINGS_BYTES) {
      onInvalid?.('update settings: file too large, using defaults');
      return null;
    }
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function loadUpdateSettings(dir: string, onInvalid?: (problem: string) => void): UpdateSettings {
  const text = readSettingsFile(join(dir, UPDATE_SETTINGS_FILE), onInvalid);
  if (text === null) return { ...DEFAULT_UPDATE_SETTINGS };
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

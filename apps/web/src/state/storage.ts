// Browser localStorage under the `chartmate.` prefix. public/theme-init.js reads the theme key before first paint.

export const STORAGE_PREFIX = 'chartmate.';

/** Reads `chartmate.<name>`. Null when unset or unavailable. */
export function readStored(name: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + name);
  } catch {
    return null;
  }
}

/** Writes `chartmate.<name>`. Silently ignored when storage is unavailable. */
export function writeStored(name: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + name, value);
  } catch { /* storage unavailable */ }
}

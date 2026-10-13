// Browser localStorage under the `chartmate.` prefix. Values saved before the rename to Chartmate live under
// `altv.`; they are moved to the new key on first read (or overwritten and removed on first write), so nothing a
// user saved is lost. public/theme-init.js applies the same rule to the theme key before first paint.

export const STORAGE_PREFIX = 'chartmate.';
export const LEGACY_STORAGE_PREFIX = 'altv.';

/** Reads `chartmate.<name>`, migrating a legacy `altv.<name>` value when only that one exists. Null when unset or unavailable. */
export function readStored(name: string): string | null {
  try {
    const current = localStorage.getItem(STORAGE_PREFIX + name);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_STORAGE_PREFIX + name);
    if (legacy === null) return null;
    localStorage.setItem(STORAGE_PREFIX + name, legacy);
    localStorage.removeItem(LEGACY_STORAGE_PREFIX + name);
    return legacy;
  } catch {
    return null;
  }
}

/** Writes `chartmate.<name>` and drops any legacy `altv.<name>` copy. Silently ignored when storage is unavailable. */
export function writeStored(name: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + name, value);
    localStorage.removeItem(LEGACY_STORAGE_PREFIX + name);
  } catch { /* storage unavailable */ }
}

/**
 * Moves every remaining `altv.*` key to `chartmate.*` (an existing new key wins and the legacy copy is dropped).
 * Run once at startup so keys without a dedicated reader are carried over too.
 */
export function migrateLegacyStorage(): void {
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(LEGACY_STORAGE_PREFIX)) legacyKeys.push(k);
    }
    for (const k of legacyKeys) readStored(k.slice(LEGACY_STORAGE_PREFIX.length));
    for (const k of legacyKeys) {
      const name = k.slice(LEGACY_STORAGE_PREFIX.length);
      if (localStorage.getItem(STORAGE_PREFIX + name) !== null) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

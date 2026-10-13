/** Prefix of the app's own environment variables (`CHARTMATE_PASSWORD`, …). */
export const ENV_PREFIX = 'CHARTMATE_';
/** Prefix used before the project was renamed to Chartmate; still accepted as a fallback. */
export const LEGACY_ENV_PREFIX = 'ALTV_';

/**
 * Value of `CHARTMATE_<name>`, or of the legacy `ALTV_<name>` when the new variable is not set at all. Presence
 * decides, not the value: `CHARTMATE_PASSWORD=` (empty) wins over `ALTV_PASSWORD=x`, so a deployment can always
 * override a stale legacy variable with the new name.
 */
export function brandEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const current = env[ENV_PREFIX + name];
  return current !== undefined ? current : env[LEGACY_ENV_PREFIX + name];
}

/** Legacy `ALTV_<name>` variables that are set but ignored because `CHARTMATE_<name>` is present (startup warning). */
export function shadowedLegacyVars(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  return names
    .filter((n) => env[ENV_PREFIX + n] !== undefined && env[LEGACY_ENV_PREFIX + n] !== undefined)
    .map((n) => LEGACY_ENV_PREFIX + n);
}

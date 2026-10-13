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

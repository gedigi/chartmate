/** Strict semantic versions (https://semver.org), just what the updater needs: parse, compare, pre-release. */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const NUM = '(0|[1-9]\\d{0,8})';
const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function parseSemver(v: unknown): SemVer | null {
  if (typeof v !== 'string' || v.length > 128) return null;
  const m = SEMVER.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** -1, 0 or 1 by semver precedence (build metadata ignored). Throws on an invalid version. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error('invalid version');
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** True only when both are valid and `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: unknown, current: string): boolean {
  if (!parseSemver(candidate) || !parseSemver(current)) return false;
  return compareSemver(candidate as string, current) > 0;
}

export function isPrereleaseVersion(v: string): boolean {
  return (parseSemver(v)?.prerelease.length ?? 0) > 0;
}

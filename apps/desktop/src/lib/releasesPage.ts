import { releasesPageUrl } from '../../build/repository.cjs';

export { releasesPageUrl };

/**
 * The only URL the app ever opens in the browser (shell.openExternal): the GitHub releases page of the repository it
 * was built from, baked in at bundle time. `url` must equal `expected` exactly, and `expected` must itself be such a
 * page (https, github.com, default port, no credentials, query or fragment, `/<owner>/<name>/releases`).
 */
export function isAllowedReleasesUrl(url: string, expected: string): boolean {
  if (url !== expected) return false;
  let u: URL;
  try {
    u = new URL(expected);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password || u.search || u.hash) return false;
  const m = /^\/([^/]+\/[^/]+)\/releases$/.exec(u.pathname);
  return m !== null && releasesPageUrl(m[1]) === expected && u.href === expected;
}

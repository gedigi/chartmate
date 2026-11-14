import { GITHUB_WEB, installUrl } from '../../../server/src/sync/githubAuth.js';

/**
 * The GitHub pages the Sync panel links to, the only links the window may open (in the default browser, through
 * `hardenWebContents`' window-open handler): the device sign-in page, the Chartmate Sync app's install page and the
 * new fine-grained token page. Exact addresses only: anything else the page asks to open stays blocked.
 */
export const GITHUB_LINKS: ReadonlySet<string> = new Set([
  `${GITHUB_WEB}/login/device`,
  installUrl(),
  `${GITHUB_WEB}/settings/personal-access-tokens/new`,
]);

/** Whether `url` is exactly one of `GITHUB_LINKS` (https, github.com, no credentials, query or fragment). */
export function isAllowedGitHubLink(url: string): boolean {
  if (!GITHUB_LINKS.has(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.href === url && u.protocol === 'https:' && u.host === 'github.com' && !u.username && !u.password && !u.search && !u.hash;
}

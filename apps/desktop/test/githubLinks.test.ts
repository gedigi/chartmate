import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installUrl } from '../../server/src/sync/githubAuth.js';
import { GITHUB_LINKS, isAllowedGitHubLink } from '../src/lib/githubLinks.js';

describe('GitHub links the window may open', () => {
  it('are exactly the Sync panel\'s three pages', () => {
    expect([...GITHUB_LINKS].sort()).toEqual([
      'https://github.com/apps/chartmate-sync/installations/new',
      'https://github.com/login/device',
      'https://github.com/settings/personal-access-tokens/new',
    ]);
    expect(GITHUB_LINKS.has(installUrl())).toBe(true);
  });

  it('include the token page the web Sync panel links to', () => {
    const web = readFileSync(new URL('../../web/src/components/SyncDialog.tsx', import.meta.url), 'utf8');
    const token = /export const NEW_TOKEN_URL = '([^']+)'/.exec(web)?.[1];
    expect(token && GITHUB_LINKS.has(token)).toBe(true);
  });

  it('accepts only those exact strings', () => {
    for (const u of GITHUB_LINKS) expect(isAllowedGitHubLink(u), u).toBe(true);
    for (const u of [
      'https://github.com/login/device/', 'https://github.com/login/device?next=x', 'https://github.com/login/device#x',
      'https://github.com/login/device ', 'HTTPS://github.com/login/device', 'https://evil.com/login/device',
      'https://github.com.evil.com/login/device', 'javascript:alert(1)', '',
    ]) expect(isAllowedGitHubLink(u), u).toBe(false);
  });
});

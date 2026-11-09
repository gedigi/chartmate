import { describe, expect, it, vi } from 'vitest';
import { GITHUB_APP, GitHubAppAuth, installUrl } from '../../src/sync/githubAuth.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const form = (init: RequestInit | undefined) => Object.fromEntries(new URLSearchParams(init!.body as string));
const NOW = 1_700_000_000_000;

describe('GitHubAppAuth', () => {
  it('starts the device flow with the public client ID only (no secret)', async () => {
    const f = vi.fn<typeof fetch>(async () => json({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }));
    const auth = new GitHubAppAuth(f, GITHUB_APP.clientId, () => NOW);
    expect(await auth.startDeviceFlow()).toEqual({ deviceCode: 'dc', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: NOW + 900_000, interval: 5 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://github.com/login/device/code');
    expect(form(init)).toEqual({ client_id: 'Iv23liwZ2kRTFFCh2Etb' });
    expect(JSON.stringify(init)).not.toMatch(/secret/i);
  });

  it('never shows an address off github.com; a disabled device flow is a readable error', async () => {
    const odd = new GitHubAppAuth(async () => json({ device_code: 'dc', user_code: 'X', verification_uri: 'https://evil.example/login', expires_in: 900 }), 'id', () => NOW);
    expect((await odd.startDeviceFlow()).verificationUri).toBe('https://github.com/login/device');
    await expect(new GitHubAppAuth(async () => json({ error: 'device_flow_disabled' })).startDeviceFlow()).rejects.toThrow(/not enabled/);
  });

  it('polls: pending, slow down, denied, expired, then the credentials with their lifetimes', async () => {
    const f = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(json({ error: 'slow_down', interval: 10 }))
      .mockResolvedValueOnce(json({ error: 'access_denied' }))
      .mockResolvedValueOnce(json({ error: 'expired_token' }))
      .mockResolvedValueOnce(json({ access_token: 'ghu_a', expires_in: 28_800, refresh_token: 'ghr_a', refresh_token_expires_in: 15_811_200 }));
    const auth = new GitHubAppAuth(f, 'id', () => NOW);
    expect(await auth.pollDeviceFlow('dc')).toEqual({ state: 'pending', interval: 0 });
    expect(await auth.pollDeviceFlow('dc')).toEqual({ state: 'pending', interval: 10 });
    expect(await auth.pollDeviceFlow('dc')).toEqual({ state: 'denied' });
    expect(await auth.pollDeviceFlow('dc')).toEqual({ state: 'expired' });
    expect(await auth.pollDeviceFlow('dc')).toEqual({
      state: 'ok', credentials: { access: 'ghu_a', accessExpiresAt: NOW + 28_800_000, refresh: 'ghr_a', refreshExpiresAt: NOW + 15_811_200_000 },
    });
    expect(f.mock.calls[0]![0]).toBe('https://github.com/login/oauth/access_token');
    expect(form(f.mock.calls[0]![1])).toEqual({ client_id: 'id', device_code: 'dc', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  });

  it('refreshes without a secret; a refused refresh means signing in again', async () => {
    const f = vi.fn<typeof fetch>(async () => json({ access_token: 'ghu_b', expires_in: 28_800, refresh_token: 'ghr_b', refresh_token_expires_in: 100 }));
    expect((await new GitHubAppAuth(f, 'id', () => NOW).refresh('ghr_a')).refresh).toBe('ghr_b');
    expect(form(f.mock.calls[0]![1])).toEqual({ client_id: 'id', refresh_token: 'ghr_a', grant_type: 'refresh_token' });
    await expect(new GitHubAppAuth(async () => json({ error: 'bad_refresh_token' })).refresh('x')).rejects.toThrow(/sign in again/);
  });

  it('lists the repositories of the app’s installations, with the account, sending the token only to the API', async () => {
    const f = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith('/user')) return json({ login: 'octocat' });
      if (u.includes('/user/installations?')) return json({ installations: [{ id: 7 }] });
      if (u.includes('/user/installations/7/repositories')) return json({ repositories: [{ full_name: 'octocat/z', private: false }, { full_name: 'octocat/chartmate-data', private: true }] });
      return json({}, 404);
    });
    const auth = new GitHubAppAuth(f, 'id', () => NOW);
    expect(await auth.account('ghu_a')).toBe('octocat');
    expect(await auth.repositories('ghu_a')).toEqual([{ repo: 'octocat/chartmate-data', private: true }, { repo: 'octocat/z', private: false }]);
    for (const [url, init] of f.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//);
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ghu_a');
    }
    await expect(new GitHubAppAuth(async () => json({}, 401)).account('x')).rejects.toThrow(/sign in again/);
  });

  it('the install page is the app’s own', () => {
    expect(installUrl()).toBe('https://github.com/apps/chartmate-sync/installations/new');
  });
});

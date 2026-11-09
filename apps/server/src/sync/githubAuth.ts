import { GITHUB_API, SyncRemoteError } from './github.js';

/**
 * Sign-in with GitHub for sync, through the Chartmate Sync GitHub App and GitHub's device flow: the user approves a
 * short code on github.com, and the app gets a user token limited to what the GitHub App may do (Contents: read and
 * write) on the repositories the user installed it on. No client secret exists anywhere: the device flow and its
 * token refresh need only the public client ID. Tokens last 8 hours and are refreshed here; the refresh token lasts
 * 6 months and is replaced at each refresh.
 */

/** The Chartmate Sync GitHub App (public values; a fork that registers its own app changes them here). */
export const GITHUB_APP = Object.freeze({ clientId: 'Iv23liwZ2kRTFFCh2Etb', slug: 'chartmate-sync' });
export const GITHUB_WEB = 'https://github.com';
/** Where the user picks the repositories the app may use. */
export const installUrl = (slug = GITHUB_APP.slug): string => `${GITHUB_WEB}/apps/${slug}/installations/new`;

export interface AppCredentials {
  access: string;
  /** null: a token that does not expire. */
  accessExpiresAt: number | null;
  refresh: string | null;
  refreshExpiresAt: number | null;
}

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; interval: number }

export type PollResult =
  | { state: 'pending'; interval: number }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'ok'; credentials: AppCredentials };

export interface RepoChoice { repo: string; private: boolean }

/** What the sync service needs from GitHub sign-in (GitHubAppAuth; a fake in tests). */
export interface AppAuth {
  startDeviceFlow(): Promise<DeviceCode>;
  pollDeviceFlow(deviceCode: string): Promise<PollResult>;
  refresh(refreshToken: string): Promise<AppCredentials>;
  account(access: string): Promise<string>;
  repositories(access: string): Promise<RepoChoice[]>;
}

const TIMEOUT_MS = 20_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class GitHubAppAuth implements AppAuth {
  private readonly fetch: typeof fetch;

  /** `fetchImpl`: resolved per call by default (the desktop app passes its sync-only guarded fetch). */
  constructor(fetchImpl?: typeof fetch, private readonly clientId: string = GITHUB_APP.clientId, private readonly now: () => number = Date.now) {
    this.fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async call(url: string, init: { method: 'GET' | 'POST'; form?: Record<string, string>; token?: string }): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: init.method,
        headers: {
          Accept: url.startsWith(GITHUB_API) ? 'application/vnd.github+json' : 'application/json',
          'User-Agent': 'Chartmate',
          ...(url.startsWith(GITHUB_API) ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SyncRemoteError('Could not reach GitHub');
    }
  }

  /** The login endpoints answer 200 with `{ error }` for most outcomes. */
  private async login(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.call(`${GITHUB_WEB}${path}`, { method: 'POST', form: { client_id: this.clientId, ...form } });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (typeof body !== 'object' || body === null) throw new SyncRemoteError(`GitHub answered ${res.status}`, res.status);
    return body as Record<string, unknown>;
  }

  async startDeviceFlow(): Promise<DeviceCode> {
    const b = await this.login('/login/device/code', {});
    if (b.error === 'device_flow_disabled') throw new SyncRemoteError('Sign-in with GitHub is not enabled for this app');
    if (b.error === 'unauthorized_client' || b.error === 'incorrect_client_credentials') {
      throw new SyncRemoteError('GitHub does not know this app (its client ID is wrong)');
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri, expires_in: expiresIn, interval } = b;
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof uri !== 'string' || typeof expiresIn !== 'number') {
      throw new SyncRemoteError('GitHub sent an unexpected answer');
    }
    // Shown to the user as the address to open: only GitHub's own page.
    const verificationUri = uri.startsWith(`${GITHUB_WEB}/`) ? uri : `${GITHUB_WEB}/login/device`;
    return { deviceCode, userCode, verificationUri, expiresAt: this.now() + expiresIn * 1000, interval: typeof interval === 'number' ? interval : 5 };
  }

  async pollDeviceFlow(deviceCode: string): Promise<PollResult> {
    const b = await this.login('/login/oauth/access_token', { device_code: deviceCode, grant_type: DEVICE_GRANT });
    if (b.error === 'authorization_pending') return { state: 'pending', interval: 0 };
    if (b.error === 'slow_down') return { state: 'pending', interval: typeof b.interval === 'number' ? b.interval : 10 };
    if (b.error === 'access_denied') return { state: 'denied' };
    if (b.error === 'expired_token' || b.error === 'incorrect_device_code') return { state: 'expired' };
    if (b.error !== undefined) throw new SyncRemoteError('GitHub refused the sign-in; try again');
    return { state: 'ok', credentials: this.credentials(b) };
  }

  async refresh(refreshToken: string): Promise<AppCredentials> {
    const b = await this.login('/login/oauth/access_token', { refresh_token: refreshToken, grant_type: 'refresh_token' });
    if (b.error !== undefined) throw new SyncRemoteError('GitHub signed this device out; sign in again', 401);
    return this.credentials(b);
  }

  private credentials(b: Record<string, unknown>): AppCredentials {
    if (typeof b.access_token !== 'string' || b.access_token === '') throw new SyncRemoteError('GitHub sent an unexpected answer');
    const at = (s: unknown) => (typeof s === 'number' && s > 0 ? this.now() + s * 1000 : null);
    return {
      access: b.access_token,
      accessExpiresAt: at(b.expires_in),
      refresh: typeof b.refresh_token === 'string' && b.refresh_token !== '' ? b.refresh_token : null,
      refreshExpiresAt: at(b.refresh_token_expires_in),
    };
  }

  private async api<T>(path: string, access: string): Promise<T> {
    const res = await this.call(`${GITHUB_API}${path}`, { method: 'GET', token: access });
    if (res.status === 401) throw new SyncRemoteError('GitHub signed this device out; sign in again', 401);
    if (!res.ok) throw new SyncRemoteError(`GitHub answered ${res.status}`, res.status);
    return await res.json() as T;
  }

  async account(access: string): Promise<string> {
    const u = await this.api<{ login?: unknown }>('/user', access);
    if (typeof u.login !== 'string') throw new SyncRemoteError('GitHub sent an unexpected answer');
    return u.login;
  }

  /** The repositories the user installed the app on (where sync can write). */
  async repositories(access: string): Promise<RepoChoice[]> {
    const { installations } = await this.api<{ installations?: { id?: unknown }[] }>('/user/installations?per_page=100', access);
    const out: RepoChoice[] = [];
    for (const inst of installations ?? []) {
      if (typeof inst.id !== 'number') continue;
      const { repositories } = await this.api<{ repositories?: { full_name?: unknown; private?: unknown }[] }>(
        `/user/installations/${inst.id}/repositories?per_page=100`, access,
      );
      for (const r of repositories ?? []) {
        if (typeof r.full_name === 'string') out.push({ repo: r.full_name, private: r.private === true });
      }
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  }
}

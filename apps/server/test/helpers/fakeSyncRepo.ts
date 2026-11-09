import { SyncRemoteError, type RemoteFile } from '../../src/sync/github.js';
import type { AppAuth, AppCredentials, DeviceCode, PollResult, RepoChoice } from '../../src/sync/githubAuth.js';
import type { RemoteStore } from '../../src/sync/service.js';

/** A sync file with GitHub's rules: a write must name the sha it replaces. */
export class FakeRepo {
  file: RemoteFile | null = null;
  private n = 0;
  writes = 0;
  /** Runs before the next write lands (to simulate another device writing in between). */
  beforeWrite: (() => void) | null = null;
  /** Runs before every read (e.g. to throw GitHub's errors). */
  beforeRead: (() => void) | null = null;
  store(): RemoteStore {
    return {
      read: async () => { this.beforeRead?.(); return this.file ? { ...this.file } : null; },
      write: async (text, sha) => {
        const hook = this.beforeWrite;
        this.beforeWrite = null;
        hook?.();
        if ((this.file?.sha ?? null) !== sha) return 'conflict';
        this.writes++;
        this.file = { text, sha: `s${++this.n}` };
        return { sha: this.file.sha };
      },
    };
  }
  docs(): Record<string, { t: number; v?: unknown; deleted?: true }> {
    return this.file ? (JSON.parse(this.file.text) as { docs: Record<string, { t: number }> }).docs : {};
  }
}

/** GitHub sign-in as the service sees it: a scripted device flow, refreshes counted, repositories as set. */
export class FakeAuth implements AppAuth {
  polls: PollResult[] = [{ state: 'pending', interval: 0 }];
  repos: RepoChoice[] = [];
  refreshes: string[] = [];
  refreshFails = false;
  issued = 0;
  constructor(private readonly now: () => number) {}
  creds(): AppCredentials {
    this.issued++;
    return { access: `ghu_${this.issued}`, accessExpiresAt: this.now() + 8 * 3_600_000, refresh: `ghr_${this.issued}`, refreshExpiresAt: this.now() + 180 * 86_400_000 };
  }
  async startDeviceFlow(): Promise<DeviceCode> {
    return { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: this.now() + 900_000, interval: 5 };
  }
  async pollDeviceFlow(): Promise<PollResult> {
    const next = this.polls.shift();
    return next ?? { state: 'ok', credentials: this.creds() };
  }
  async refresh(token: string): Promise<AppCredentials> {
    this.refreshes.push(token);
    if (this.refreshFails) throw new SyncRemoteError('GitHub signed this device out; sign in again', 401);
    return this.creds();
  }
  async account(): Promise<string> { return 'octocat'; }
  async repositories(): Promise<RepoChoice[]> { return this.repos; }
}

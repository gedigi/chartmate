import type { BasketService } from '../baskets/service.js';
import type { Repos } from '../db/repos.js';
import { applyRemote, collectLocal, isSyncKey } from './docs.js';
import { GitHubFile, REPO_RE, SyncRemoteError, type GitHubTarget, type RemoteFile } from './github.js';
import { GitHubAppAuth, installUrl, type AppAuth, type AppCredentials, type DeviceCode, type RepoChoice } from './githubAuth.js';
import { mergeDocs, type Base, type Docs } from './merge.js';

/**
 * Sync of the user's data (watchlist, layouts, drawings, baskets) through one JSON file in a private GitHub repository
 * of their own (see merge.ts for the rules). A full sync (pull and push) runs when the web app loads, before it reads
 * the data; local edits are pushed a few seconds later without touching what an open page shows; `check` tells an
 * open page that another device has newer data. One run at a time.
 */

/** Encrypts the stored token where the host can (the desktop app: the OS keychain); absent = stored as is. */
export interface SecretCipher { encrypt(plain: string): string; decrypt(stored: string): string }

/** The sync file and its sha, as the service needs it (GitHubFile; a fake in tests). */
export interface RemoteStore { read(): Promise<RemoteFile | null>; write(text: string, sha: string | null): Promise<{ sha: string } | 'conflict'> }

export interface SyncStatus {
  /** 'env': set by CHARTMATE_SYNC_REPO / CHARTMATE_SYNC_TOKEN (not editable here); 'app': set in the app; null: off. */
  source: 'env' | 'app' | null;
  repo: string | null;
  /** How this device reaches GitHub: signed in with the Chartmate Sync app, or a personal access token. */
  auth: 'app' | 'token' | null;
  /** The GitHub account signed in (app sign-in only). */
  account: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

/** The sign-in in progress, as the page shows it. */
export interface SignInStart { userCode: string; verificationUri: string; expiresAt: number; interval: number }
export type SignInPoll =
  | { state: 'pending'; interval: number }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'ready'; account: string; repos: RepoChoice[]; installUrl: string };

const CONFIG_KEY = 'sync_config';
const BASE_KEY = 'sync_base';
const LAST_SYNC_KEY = 'sync_last_at';
const FILE_FORMAT = 1;
const MAX_ATTEMPTS = 4;
export const PUSH_DELAY_MS = 5_000;

/** `token`: the personal access token, or (kind 'app') the JSON of the app's credentials; encrypted by the cipher. */
interface StoredConfig { repo: string; token: string; encrypted: boolean; kind: 'token' | 'app'; account: string | null }
interface Target extends GitHubTarget { kind: 'token' | 'app' }

/** An access token is refreshed when it has less than this left (a run must not outlive it). */
const REFRESH_MARGIN_MS = 5 * 60_000;

interface SignIn { code: DeviceCode; nextPollAt: number; interval: number; credentials: AppCredentials | null; account: string | null }

export class SyncService {
  private readonly repos: Repos;
  private readonly baskets: BasketService;
  private readonly env: GitHubTarget | null;
  private readonly cipher: SecretCipher | null;
  private readonly makeRemote: (t: GitHubTarget) => RemoteStore;
  private readonly now: () => number;
  private readonly pushDelayMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private off: (() => void) | null = null;
  private readonly auth: AppAuth;
  /** The GitHub sign-in in progress (kept in memory only: a restart means signing in again). */
  private signIn: SignIn | null = null;

  constructor(deps: {
    repos: Repos; baskets: BasketService; env?: GitHubTarget | null; cipher?: SecretCipher | null;
    remote?: (t: GitHubTarget) => RemoteStore; now?: () => number; pushDelayMs?: number; auth?: AppAuth;
  }) {
    this.repos = deps.repos;
    this.baskets = deps.baskets;
    this.env = deps.env ?? null;
    this.cipher = deps.cipher ?? null;
    this.makeRemote = deps.remote ?? ((t) => new GitHubFile(t));
    this.auth = deps.auth ?? new GitHubAppAuth();
    this.now = deps.now ?? Date.now;
    this.pushDelayMs = deps.pushDelayMs ?? PUSH_DELAY_MS;
  }

  /** Pushes local edits a few seconds after they happen (while sync is on). */
  start(): void {
    this.off ??= this.repos.userDataChanges.on(() => this.schedulePush());
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedulePush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.isOn().then((on) => (on ? this.sync('push') : undefined)).catch(() => { /* kept in lastError */ });
    }, this.pushDelayMs);
    this.timer.unref?.();
  }

  async status(): Promise<SyncStatus> {
    const cfg = this.env ? null : await this.storedConfig();
    const last = await this.repos.settings.get(LAST_SYNC_KEY);
    return {
      source: this.env ? 'env' : cfg ? 'app' : null,
      repo: this.env?.repo ?? cfg?.repo ?? null,
      auth: this.env ? 'token' : cfg?.kind ?? null,
      account: this.env ? null : cfg?.account ?? null,
      lastSyncAt: last === null ? null : Number(last),
      lastError: this.lastError,
    };
  }

  /**
   * Turns sync on with this repository and token: a full sync runs first, and the settings are kept only when it
   * succeeds (so a wrong token or repository is reported and nothing is saved).
   */
  async configure(repo: string, token: string): Promise<SyncStatus & { applied: number }> {
    if (this.env) throw new SyncRemoteError('Sync is set by the server (CHARTMATE_SYNC_REPO)');
    const target = { repo: repo.trim(), token: token.trim() };
    if (!REPO_RE.test(target.repo)) throw new SyncRemoteError('The repository must be written as owner/name');
    if (target.token === '') throw new SyncRemoteError('Enter a token');
    // `applied`: documents the repository brought here (the page reloads to show them).
    const applied = await this.exclusive(async () => {
      await this.repos.settings.delete(BASE_KEY); // a new repository: no agreed state yet, nothing is a deletion
      const r = await this.run({ ...target, kind: 'token' }, 'full');
      await this.saveConfig({ repo: target.repo, kind: 'token', account: null }, target.token);
      this.signIn = null;
      return r.applied;
    });
    return { ...(await this.status()), applied };
  }

  /** Starts signing in with GitHub (the device flow): the code the user enters at `verificationUri`. */
  async startSignIn(): Promise<SignInStart> {
    if (this.env) throw new SyncRemoteError('Sync is set by the server (CHARTMATE_SYNC_REPO)');
    const code = await this.auth.startDeviceFlow();
    this.signIn = { code, nextPollAt: this.now() + code.interval * 1000, interval: code.interval, credentials: null, account: null };
    return { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt, interval: code.interval };
  }

  /**
   * The sign-in's progress: GitHub is asked at most once per interval it set. Once approved, the repositories the
   * app may use (asking again lists them again, after the user installed the app on one).
   */
  async pollSignIn(): Promise<SignInPoll> {
    const s = this.signIn;
    if (!s) throw new SyncRemoteError('Start signing in again');
    if (!s.credentials) {
      if (this.now() >= s.code.expiresAt) {
        this.signIn = null;
        return { state: 'expired' };
      }
      if (this.now() < s.nextPollAt) return { state: 'pending', interval: s.interval };
      const r = await this.auth.pollDeviceFlow(s.code.deviceCode);
      if (this.signIn !== s) throw new SyncRemoteError('Start signing in again');
      if (r.state === 'pending') {
        if (r.interval > s.interval) s.interval = r.interval;
        s.nextPollAt = this.now() + s.interval * 1000;
        return { state: 'pending', interval: s.interval };
      }
      if (r.state !== 'ok') {
        this.signIn = null;
        return r;
      }
      s.account = await this.auth.account(r.credentials.access);
      s.credentials = r.credentials;
    }
    const repos = await this.auth.repositories(s.credentials.access);
    return { state: 'ready', account: s.account ?? '', repos, installUrl: installUrl() };
  }

  /** Turns sync on with the signed-in account and one of its repositories (a first sync runs before it is saved). */
  async connectSignedIn(repo: string): Promise<SyncStatus & { applied: number }> {
    if (this.env) throw new SyncRemoteError('Sync is set by the server (CHARTMATE_SYNC_REPO)');
    const s = this.signIn;
    if (!s?.credentials) throw new SyncRemoteError('Sign in with GitHub first');
    const credentials = s.credentials;
    const choice = (await this.auth.repositories(credentials.access)).find((r) => r.repo === repo);
    if (!choice) throw new SyncRemoteError('Chartmate Sync cannot use that repository; choose it on GitHub first');
    if (!choice.private) throw new SyncRemoteError('Choose a private repository: anyone can read a public one');
    const applied = await this.exclusive(async () => {
      await this.repos.settings.delete(BASE_KEY);
      const r = await this.run({ repo, token: credentials.access, kind: 'app' }, 'full');
      await this.saveConfig({ repo, kind: 'app', account: s.account }, JSON.stringify(credentials));
      if (this.signIn === s) this.signIn = null;
      return r.applied;
    });
    return { ...(await this.status()), applied };
  }

  /** Turns sync off here (the repository and the data on both sides stay as they are). */
  async disconnect(): Promise<void> {
    if (this.env) throw new SyncRemoteError('Sync is set by the server (CHARTMATE_SYNC_REPO)');
    await this.exclusive(async () => {
      await this.repos.settings.delete(CONFIG_KEY);
      await this.repos.settings.delete(BASE_KEY);
      await this.repos.settings.delete(LAST_SYNC_KEY);
      this.lastError = null;
      this.signIn = null;
    });
  }

  /** A sync run; null when sync is off. 'full' applies newer remote data here, 'push' only sends local edits. */
  async sync(mode: 'full' | 'push'): Promise<{ applied: number; pushed: boolean } | null> {
    return this.exclusive(async () => {
      const target = await this.target().catch((e: unknown) => { this.lastError = message(e); throw e; });
      return target ? this.run(target, mode) : null;
    });
  }

  /** Whether the sync file holds data newer than this device's (a reload would bring it in). */
  async check(): Promise<{ remoteNewer: boolean } | null> {
    return this.exclusive(async () => {
      const target = await this.target().catch((e: unknown) => { this.lastError = message(e); throw e; });
      if (!target) return null;
      try {
        const file = await this.makeRemote(target).read();
        const merged = mergeDocs(await collectLocal(this.repos), parseFile(file), await this.base(), this.now(), 'push');
        this.lastError = null;
        return { remoteNewer: merged.remoteNewer.some(isSyncKey) };
      } catch (e) {
        this.lastError = message(e);
        throw e;
      }
    });
  }

  private async run(target: Target, mode: 'full' | 'push'): Promise<{ applied: number; pushed: boolean }> {
    try {
      const remote = this.makeRemote(target);
      for (let attempt = 1; ; attempt++) {
        const file = await remote.read();
        const merged = mergeDocs(await collectLocal(this.repos), parseFile(file), await this.base(), this.now(), mode);
        let pushed = false;
        if (merged.remoteChanged) {
          const w = await remote.write(serialize(merged.remote), file?.sha ?? null);
          if (w === 'conflict') {
            if (attempt >= MAX_ATTEMPTS) throw new SyncRemoteError('The sync file keeps changing; try again');
            continue;
          }
          pushed = true;
        }
        const { applied, skipped } = await applyRemote(this.repos, this.baskets, merged.applyLocal);
        const base = { ...merged.base };
        // A document that could not be applied keeps no agreed state: this device's copy counts as its own edit.
        for (const key of skipped) delete base[key];
        await this.repos.settings.set(BASE_KEY, JSON.stringify(base));
        await this.repos.settings.set(LAST_SYNC_KEY, String(this.now()));
        this.lastError = null;
        return { applied, pushed };
      }
    } catch (e) {
      const err = target.kind === 'app' && e instanceof SyncRemoteError && e.status === 401
        ? new SyncRemoteError('GitHub signed this device out; sign in again', 401) : e;
      this.lastError = message(err);
      throw err;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async isOn(): Promise<boolean> {
    return this.env !== null || (await this.storedConfig()) !== null;
  }

  /** The repository and a usable token. Refreshes an app token about to expire: call it inside `exclusive` only. */
  private async target(): Promise<Target | null> {
    if (this.env) return { ...this.env, kind: 'token' };
    const cfg = await this.storedConfig();
    if (!cfg) return null;
    const secret = this.secret(cfg);
    if (cfg.kind === 'token') return { repo: cfg.repo, token: secret, kind: 'token' };
    let c: AppCredentials;
    try {
      c = JSON.parse(secret) as AppCredentials;
      if (typeof c.access !== 'string') throw new Error('bad');
    } catch {
      throw new SyncRemoteError('The saved GitHub sign-in cannot be read; sign in again');
    }
    if (c.accessExpiresAt !== null && c.accessExpiresAt - this.now() < REFRESH_MARGIN_MS) {
      if (!c.refresh || (c.refreshExpiresAt !== null && c.refreshExpiresAt <= this.now())) {
        throw new SyncRemoteError('GitHub signed this device out; sign in again', 401);
      }
      c = await this.auth.refresh(c.refresh);
      // The old refresh token is spent: keep the new one at once, whatever the run does next.
      await this.saveConfig(cfg, JSON.stringify(c));
    }
    return { repo: cfg.repo, token: c.access, kind: 'app' };
  }

  private secret(cfg: StoredConfig): string {
    if (!cfg.encrypted) return cfg.token;
    // Encrypted by the desktop app's OS keychain: unreadable elsewhere (a copied database) or after a keychain reset.
    const unreadable = new SyncRemoteError('The saved GitHub token cannot be read on this device; connect again');
    if (!this.cipher) throw unreadable;
    try {
      return this.cipher.decrypt(cfg.token);
    } catch {
      throw unreadable;
    }
  }

  private async storedConfig(): Promise<StoredConfig | null> {
    const raw = await this.repos.settings.get(CONFIG_KEY);
    if (raw === null) return null;
    try {
      const c = JSON.parse(raw) as Partial<StoredConfig>;
      if (typeof c.repo !== 'string' || typeof c.token !== 'string') return null;
      return {
        repo: c.repo, token: c.token, encrypted: c.encrypted === true,
        kind: c.kind === 'app' ? 'app' : 'token', account: typeof c.account === 'string' ? c.account : null,
      };
    } catch {
      return null;
    }
  }

  private async saveConfig(c: Pick<StoredConfig, 'repo' | 'kind' | 'account'>, secret: string): Promise<void> {
    let stored: StoredConfig;
    if (!this.cipher) stored = { repo: c.repo, kind: c.kind, account: c.account, token: secret, encrypted: false };
    else {
      try {
        stored = { repo: c.repo, kind: c.kind, account: c.account, token: this.cipher.encrypt(secret), encrypted: true };
      } catch {
        throw new SyncRemoteError('The token could not be stored securely (the system keychain is unavailable)');
      }
    }
    await this.repos.settings.set(CONFIG_KEY, JSON.stringify(stored));
  }

  private async base(): Promise<Base> {
    const raw = await this.repos.settings.get(BASE_KEY);
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as Base;
    } catch {
      return {};
    }
  }
}

function serialize(docs: Docs): string {
  return `${JSON.stringify({ format: FILE_FORMAT, docs }, null, 1)}\n`;
}

/** The documents of the sync file (none when there is no file). An unreadable file stops the sync: it is never overwritten. */
function parseFile(file: RemoteFile | null): Docs {
  if (!file || file.text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw new SyncRemoteError('The sync file in the repository is not valid JSON; fix or delete it');
  }
  const p = parsed as { format?: unknown; docs?: unknown };
  if (typeof p !== 'object' || p === null || typeof p.docs !== 'object' || p.docs === null) {
    throw new SyncRemoteError('The sync file in the repository is not a Chartmate sync file');
  }
  if (typeof p.format === 'number' && p.format > FILE_FORMAT) {
    throw new SyncRemoteError('The sync file was written by a newer Chartmate; update this one');
  }
  const out: Docs = {};
  for (const [key, d] of Object.entries(p.docs as Record<string, unknown>)) {
    const doc = d as { t?: unknown; v?: unknown; deleted?: unknown } | null;
    if (!doc || typeof doc.t !== 'number' || !Number.isFinite(doc.t)) continue;
    out[key] = doc.deleted === true ? { t: doc.t, deleted: true } : { t: doc.t, v: doc.v };
  }
  return out;
}

function message(e: unknown): string {
  return e instanceof SyncRemoteError ? e.message : 'Sync failed';
}

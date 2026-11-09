import type { BasketService } from '../baskets/service.js';
import type { Repos } from '../db/repos.js';
import { applyRemote, collectLocal, isSyncKey } from './docs.js';
import { GitHubFile, REPO_RE, SyncRemoteError, type GitHubTarget, type RemoteFile } from './github.js';
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
  lastSyncAt: number | null;
  lastError: string | null;
}

const CONFIG_KEY = 'sync_config';
const BASE_KEY = 'sync_base';
const LAST_SYNC_KEY = 'sync_last_at';
const FILE_FORMAT = 1;
const MAX_ATTEMPTS = 4;
export const PUSH_DELAY_MS = 5_000;

interface StoredConfig { repo: string; token: string; encrypted: boolean }

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

  constructor(deps: {
    repos: Repos; baskets: BasketService; env?: GitHubTarget | null; cipher?: SecretCipher | null;
    remote?: (t: GitHubTarget) => RemoteStore; now?: () => number; pushDelayMs?: number;
  }) {
    this.repos = deps.repos;
    this.baskets = deps.baskets;
    this.env = deps.env ?? null;
    this.cipher = deps.cipher ?? null;
    this.makeRemote = deps.remote ?? ((t) => new GitHubFile(t));
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
      void this.target().then((t) => (t ? this.sync('push') : undefined)).catch(() => { /* kept in lastError */ });
    }, this.pushDelayMs);
    this.timer.unref?.();
  }

  async status(): Promise<SyncStatus> {
    const cfg = this.env ? null : await this.storedConfig();
    const last = await this.repos.settings.get(LAST_SYNC_KEY);
    return {
      source: this.env ? 'env' : cfg ? 'app' : null,
      repo: this.env?.repo ?? cfg?.repo ?? null,
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
      const r = await this.run(target, 'full');
      await this.repos.settings.set(CONFIG_KEY, JSON.stringify(this.encode(target)));
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
    });
  }

  /** A sync run; null when sync is off. 'full' applies newer remote data here, 'push' only sends local edits. */
  async sync(mode: 'full' | 'push'): Promise<{ applied: number; pushed: boolean } | null> {
    return this.exclusive(async () => {
      const target = await this.target();
      return target ? this.run(target, mode) : null;
    });
  }

  /** Whether the sync file holds data newer than this device's (a reload would bring it in). */
  async check(): Promise<{ remoteNewer: boolean } | null> {
    return this.exclusive(async () => {
      const target = await this.target();
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

  private async run(target: GitHubTarget, mode: 'full' | 'push'): Promise<{ applied: number; pushed: boolean }> {
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
      this.lastError = message(e);
      throw e;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async target(): Promise<GitHubTarget | null> {
    if (this.env) return this.env;
    const cfg = await this.storedConfig();
    if (!cfg) return null;
    if (!cfg.encrypted) return { repo: cfg.repo, token: cfg.token };
    // Encrypted by the desktop app's OS keychain: unreadable elsewhere (a copied database) or after a keychain reset.
    const unreadable = new SyncRemoteError('The saved GitHub token cannot be read on this device; connect again');
    if (!this.cipher) throw unreadable;
    try {
      return { repo: cfg.repo, token: this.cipher.decrypt(cfg.token) };
    } catch {
      throw unreadable;
    }
  }

  private async storedConfig(): Promise<StoredConfig | null> {
    const raw = await this.repos.settings.get(CONFIG_KEY);
    if (raw === null) return null;
    try {
      const c = JSON.parse(raw) as Partial<StoredConfig>;
      return typeof c.repo === 'string' && typeof c.token === 'string' ? { repo: c.repo, token: c.token, encrypted: c.encrypted === true } : null;
    } catch {
      return null;
    }
  }

  private encode(t: GitHubTarget): StoredConfig {
    if (!this.cipher) return { repo: t.repo, token: t.token, encrypted: false };
    try {
      return { repo: t.repo, token: this.cipher.encrypt(t.token), encrypted: true };
    } catch {
      throw new SyncRemoteError('The token could not be stored securely (the system keychain is unavailable)');
    }
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

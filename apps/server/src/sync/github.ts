/**
 * The sync file in a private GitHub repository, through the REST contents API: read it with its blob sha, and write it
 * naming the sha it replaces, so a write over a newer version is refused ('conflict') instead of losing it. The token
 * is a fine-grained personal access token limited to that one repository (Contents: read and write).
 */

export const GITHUB_API = 'https://api.github.com';
/** Where the file lives in the repository. */
export const SYNC_FILE = 'chartmate-sync.json';
/** "owner/name", as GitHub allows them; the name never "." or ".." (they would move the URL's path). */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export interface GitHubTarget { repo: string; token: string }
export interface RemoteFile { text: string; sha: string }

/** A failure to show the user as is (no token or response body in it). */
export class SyncRemoteError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'SyncRemoteError';
  }
}

const TIMEOUT_MS = 20_000;

export class GitHubFile {
  private readonly fetch: typeof fetch;

  /** `fetchImpl`: resolved per call by default (the desktop app guards `globalThis.fetch` with its host allowlist). */
  constructor(private readonly target: GitHubTarget, fetchImpl?: typeof fetch) {
    this.fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    if (!REPO_RE.test(target.repo)) throw new SyncRemoteError('The repository must be written as owner/name');
  }

  private url(): string {
    const [owner, name] = this.target.repo.split('/') as [string, string];
    return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${SYNC_FILE}`;
  }

  private async call(method: 'GET' | 'PUT', accept: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetch(this.url(), {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.target.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Chartmate',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SyncRemoteError('Could not reach GitHub');
    }
  }

  /** The file and its sha, or null when the repository has no sync file yet. */
  async read(): Promise<RemoteFile | null> {
    const res = await this.call('GET', 'application/vnd.github+json');
    if (res.status === 404) {
      // A missing file and a missing (or unreachable) repository both answer 404: the write tells them apart.
      return null;
    }
    if (!res.ok) throw httpError(res);
    const meta = await res.json() as { sha?: unknown; content?: unknown; encoding?: unknown; size?: unknown };
    if (typeof meta.sha !== 'string') throw new SyncRemoteError('GitHub sent an unexpected answer');
    // Files over 1 MB come without content in this answer: read them raw.
    if (meta.encoding === 'base64' && typeof meta.content === 'string' && (meta.content !== '' || meta.size === 0)) {
      return { text: Buffer.from(meta.content, 'base64').toString('utf8'), sha: meta.sha };
    }
    const raw = await this.call('GET', 'application/vnd.github.raw+json');
    if (!raw.ok) throw httpError(raw);
    return { text: await raw.text(), sha: meta.sha };
  }

  /** Writes the file over `sha` (null: creates it). 'conflict' when it changed since that read. */
  async write(text: string, sha: string | null): Promise<{ sha: string } | 'conflict'> {
    const res = await this.call('PUT', 'application/vnd.github+json', {
      message: 'Chartmate sync',
      content: Buffer.from(text, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    });
    // 409: the sha is not the file's current one; 422: a sha is missing because the file appeared meanwhile.
    if (res.status === 409 || res.status === 422) return 'conflict';
    if (res.status === 404) throw new SyncRemoteError(`Repository ${this.target.repo} not found, or the token cannot write to it`, 404);
    if (!res.ok) throw httpError(res);
    const out = await res.json() as { content?: { sha?: unknown } };
    if (typeof out.content?.sha !== 'string') throw new SyncRemoteError('GitHub sent an unexpected answer');
    return { sha: out.content.sha };
  }
}

function httpError(res: Response): SyncRemoteError {
  if (res.status === 401) return new SyncRemoteError('GitHub refused the token (expired or revoked?)', 401);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return new SyncRemoteError('GitHub rate limit reached; try again later', 403);
  }
  if (res.status === 403) return new SyncRemoteError('The token cannot access this repository (it needs Contents: read and write)', 403);
  return new SyncRemoteError(`GitHub answered ${res.status}`, res.status);
}

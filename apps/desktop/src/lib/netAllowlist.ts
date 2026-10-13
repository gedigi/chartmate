/**
 * Outbound network allowlist for the Electron main process.
 *
 * Every provider request goes through `globalThis.fetch` (yahoo-finance2 resolves it per call; the Binance and
 * Coinbase providers are given the guarded fetch explicitly). The guard only allows HTTPS to an exact host list on
 * the default port, and follows redirects itself so that every hop is checked (a 302 to another host cannot slip
 * past the check the way it would with the built-in `redirect: 'follow'`).
 */

/**
 * Hosts yahoo-finance2 4.x talks to. Observed with live traffic (smoke/live-network.spec.ts): the cookie/crumb
 * page finance.yahoo.com and the query1/query2 APIs. From its getCrumb source: the EU cookie-consent flow
 * redirects through consent.yahoo.com and guce.yahoo.com. (fc.yahoo.com, used by older versions, is not needed.)
 */
export const YAHOO_HOSTS: readonly string[] = Object.freeze([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'finance.yahoo.com',
  'guce.yahoo.com',
  'consent.yahoo.com',
]);

export const COINBASE_HOST = 'api.exchange.coinbase.com';

export interface ProviderNetConfig {
  providers: 'live' | 'fixture';
  cryptoProvider: 'binance' | 'coinbase';
  binanceBaseUrl: string;
}

/** The exact hosts the configured providers need (none in fixture mode). */
export function providerHosts(cfg: ProviderNetConfig): string[] {
  if (cfg.providers === 'fixture') return [];
  const crypto = cfg.cryptoProvider === 'coinbase' ? COINBASE_HOST : new URL(cfg.binanceBaseUrl).hostname;
  return [...YAHOO_HOSTS, crypto];
}

export class BlockedRequestError extends Error {
  constructor(readonly host: string, reason: string) {
    super(`network request blocked by allowlist (${reason}): ${host}`);
    this.name = 'BlockedRequestError';
  }
}

function parse(url: string | URL): URL | null {
  try {
    return url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
}

function check(url: string | URL, hosts: ReadonlySet<string>): URL {
  const u = parse(url);
  if (u === null) throw new BlockedRequestError(String(url).slice(0, 80), 'invalid URL');
  if (u.protocol !== 'https:') throw new BlockedRequestError(u.host, `scheme ${u.protocol}`);
  if (u.username !== '' || u.password !== '') throw new BlockedRequestError(u.hostname, 'credentials in URL');
  if (u.port !== '') throw new BlockedRequestError(u.host, 'non-default port');
  if (!hosts.has(u.hostname)) throw new BlockedRequestError(u.hostname, 'host not allowed');
  return u;
}

export function isAllowedUrl(url: string | URL, hosts: ReadonlySet<string>): boolean {
  try {
    check(url, hosts);
    return true;
  } catch {
    return false;
  }
}

export interface GuardOptions {
  maxRedirects?: number;
  /** Notified (with the host only) whenever a request is blocked. */
  onBlocked?: (host: string) => void;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

export function createGuardedFetch(base: typeof fetch, allowed: Iterable<string>, opts: GuardOptions = {}): typeof fetch {
  const hosts: ReadonlySet<string> = new Set([...allowed].map((h) => h.toLowerCase()));
  const maxRedirects = opts.maxRedirects ?? 20;

  const guard = (url: string | URL): URL => {
    try {
      return check(url, hosts);
    } catch (err) {
      if (err instanceof BlockedRequestError) opts.onBlocked?.(err.host);
      throw err;
    }
  };

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const first = typeof input === 'string' || input instanceof URL ? input : input.url;
    let url = guard(first);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    // The caller handles redirects itself (yahoo-finance2's cookie/consent flow): every hop is a new guarded call.
    if (mode !== 'follow') return base(input, init);

    let req: string | URL | Request = input;
    let reqInit: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      const res = await base(req, reqInit);
      const location = res.headers.get('location');
      if (!REDIRECT.has(res.status) || location === null) return res;
      if (hop >= maxRedirects) throw new TypeError(`fetch failed: too many redirects (${maxRedirects})`);
      await res.body?.cancel().catch(() => {});
      const previousOrigin = url.origin;
      url = guard(new URL(location, url));
      const method = (reqInit.method ?? (req instanceof Request ? req.method : 'GET')).toUpperCase();
      const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST');
      const headers = new Headers(reqInit.headers ?? (req instanceof Request ? req.headers : undefined));
      // Like browsers (and the Fetch spec for Authorization): credentials never follow a redirect to another origin.
      if (url.origin !== previousOrigin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
      if (toGet) {
        headers.delete('content-type');
        headers.delete('content-length');
        const { body: _drop, ...rest } = reqInit;
        reqInit = { ...rest, method: method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual' };
      } else {
        reqInit = { ...reqInit, method, headers, redirect: 'manual' };
      }
      req = url.href;
    }
  };
  return guarded as typeof fetch;
}

/** Replaces `target.fetch` (normally `globalThis`) with the guarded version; returns an undo function. */
export function installFetchAllowlist(target: { fetch: typeof fetch }, allowed: Iterable<string>, opts: GuardOptions = {}): () => void {
  const original = target.fetch;
  target.fetch = createGuardedFetch(original, allowed, opts);
  return () => {
    target.fetch = original;
  };
}

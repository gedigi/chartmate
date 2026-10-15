import {
  normalizeWatchlist, WATCHLIST_STORED_HEADER,
  type BarsResponse, type Basket, type BasketVersion, type DrawingState, type LatestResponse, type Layout, type Quote,
  type SessionMode, type SymbolId, type SymbolInfo, type Timeframe, type WatchlistEntry,
} from '@chartmate/shared';

/** Any failed API call. `status` 0 means the request never got a response (network error). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Client errors that are transient by nature: retrying can succeed (timeouts, rate limits, conflicts, locks). */
const TRANSIENT_4XX: ReadonlySet<number> = new Set([401, 408, 409, 423, 425, 429]);

/**
 * A client error retrying cannot fix: a 4xx other than the transient ones (401 is the session, handled globally;
 * 408/409/423/425/429 can succeed later). Network errors (status 0) and 5xx are never permanent.
 */
export function isPermanentError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status <= 499 && !TRANSIENT_4XX.has(err.status);
}

type Query = Record<string, string | number>;

const enc = encodeURIComponent;

function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) p.set(k, String(v));
  return `?${p.toString()}`;
}

/**
 * Browsers cap the bodies of all in-flight keepalive requests together at 64 KiB (per page). Only small bodies
 * use keepalive, and only while the bytes already in flight leave room for them. Known limit: a larger PUT (a
 * layout with many indicators, a long drawing list) flushed while the page closes is sent without keepalive and
 * may be cut off; the debounced saves (~1 s) make that window small.
 */
export const KEEPALIVE_MAX_BODY = 16_000;
export const KEEPALIVE_BUDGET = 48_000;
let keepaliveInFlight = 0;

let unauthorizedHandler: (() => void) | null = null;

/**
 * Registers the single global handler called when any API request (other than `/login` and `/session`
 * themselves) fails with 401 `unauthorized`, i.e. the session expired mid-use. Pass null to unregister.
 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await requestWithHeaders<T>(method, path, body, signal)).data;
}

/** `request`, plus the response headers. */
async function requestWithHeaders<T>(
  method: string, path: string, body?: unknown, signal?: AbortSignal,
): Promise<{ data: T; headers: Headers }> {
  const init: RequestInit = { method, credentials: 'same-origin', signal };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  // Lets a save flushed from `beforeunload` complete after the page is gone (see KEEPALIVE_BUDGET).
  let keepaliveBytes = 0;
  if (method === 'PUT') {
    const bytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body).length : 0;
    if (bytes <= KEEPALIVE_MAX_BODY && keepaliveInFlight + bytes <= KEEPALIVE_BUDGET) {
      init.keepalive = true;
      keepaliveBytes = bytes;
      keepaliveInFlight += bytes;
    }
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', err instanceof Error ? err.message : 'Network error');
  } finally {
    keepaliveInFlight -= keepaliveBytes;
  }
  if (!res.ok) {
    let code = 'http_error';
    let message = `Request failed (${res.status})`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object') {
        const d = data as { code?: unknown; message?: unknown };
        if (typeof d.code === 'string') code = d.code;
        if (typeof d.message === 'string') message = d.message;
      }
    } catch { /* non-JSON error body */ }
    if (res.status === 401 && code === 'unauthorized' && path !== '/login' && path !== '/session') unauthorizedHandler?.();
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return { data: undefined as T, headers: res.headers };
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal);

/** "Not there" as null: a 404, or a 200 whose body is `null` (or empty). */
async function nullOn404<T>(p: Promise<T>): Promise<T | null> {
  try {
    return (await p) ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export interface BarsParams { symbol: SymbolId; tf: Timeframe; session: SessionMode; from: number; to: number }
export interface LatestParams { symbol: SymbolId; tf: Timeframe; session: SessionMode }

export const api = {
  session: () => get<{ authRequired: boolean; authenticated: boolean }>('/session'),
  /** The server's version (null when it does not know it). */
  about: () => get<{ version: string | null }>('/about'),
  login: async (password: string): Promise<void> => { await request<void>('POST', '/login', { password }); },
  logout: async (): Promise<void> => { await request<void>('POST', '/logout'); },

  search: (q: string, signal?: AbortSignal) => get<SymbolInfo[]>(`/symbols/search${qs({ q })}`, signal),
  symbol: (id: SymbolId) => get<SymbolInfo>(`/symbols/${enc(id)}`),
  bars: (p: BarsParams, signal?: AbortSignal) =>
    get<BarsResponse>(`/bars${qs({ symbol: p.symbol, tf: p.tf, session: p.session, from: p.from, to: p.to })}`, signal),
  latest: (p: LatestParams, signal?: AbortSignal) =>
    get<LatestResponse>(`/latest${qs({ symbol: p.symbol, tf: p.tf, session: p.session })}`, signal),
  quotes: (ids: SymbolId[]) => get<Quote[]>(`/quotes${qs({ symbols: ids.join(',') })}`),
  sparklines: (ids: SymbolId[]) => get<Record<SymbolId, number[]>>(`/sparklines${qs({ symbols: ids.join(',') })}`),

  baskets: {
    list: () => get<Basket[]>('/baskets'),
    get: (id: string) => get<Basket>(`/baskets/${enc(id)}`),
    create: (b: { name: string; versions: BasketVersion[] }) => request<Basket>('POST', '/baskets', b),
    update: (id: string, p: { name?: string; versions?: BasketVersion[] }) => request<Basket>('PUT', `/baskets/${enc(id)}`, p),
    appendVersion: (id: string, v: BasketVersion) => request<Basket>('POST', `/baskets/${enc(id)}/versions`, v),
    remove: async (id: string): Promise<void> => { await request<void>('DELETE', `/baskets/${enc(id)}`); },
  },
  watchlist: {
    /** Entries in order; a server still returning the legacy symbol id array is read as symbol entries. */
    get: async (): Promise<WatchlistEntry[]> => normalizeWatchlist(await get<unknown>('/watchlist')),
    /**
     * `get`, plus whether a watchlist was ever saved on the server (an emptied list is still a stored one); null
     * when the server does not say (an older one).
     */
    load: async (): Promise<{ entries: WatchlistEntry[]; stored: boolean | null }> => {
      const { data, headers } = await requestWithHeaders<unknown>('GET', '/watchlist');
      const h = headers.get(WATCHLIST_STORED_HEADER);
      return { entries: normalizeWatchlist(data), stored: h === '1' ? true : h === '0' ? false : null };
    },
    put: async (entries: readonly WatchlistEntry[]): Promise<void> => { await request<unknown>('PUT', '/watchlist', entries); },
  },
  layouts: {
    get: (key: string) => nullOn404(get<Layout>(`/layouts/${enc(key)}`)),
    put: async (key: string, l: Layout): Promise<void> => { await request<unknown>('PUT', `/layouts/${enc(key)}`, l); },
  },
  drawings: {
    get: (s: SymbolId) => get<DrawingState[]>(`/drawings/${enc(s)}`),
    put: async (s: SymbolId, d: DrawingState[]): Promise<void> => { await request<unknown>('PUT', `/drawings/${enc(s)}`, d); },
  },
};

export type Api = typeof api;

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import type {
  BarsResponse, Basket, BasketVersion, DrawingState, LatestResponse, Layout, Quote, SessionMode, SymbolId, SymbolInfo, Timeframe,
} from '@altv/shared';

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

type Query = Record<string, string | number>;

const enc = encodeURIComponent;

function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) p.set(k, String(v));
  return `?${p.toString()}`;
}

/**
 * Browsers cap the bodies of all in-flight keepalive requests together at 64 KiB (per page). Only small bodies
 * use keepalive, and only while the bytes already in flight leave room for them.
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
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
    get: () => get<SymbolId[]>('/watchlist'),
    put: async (ids: SymbolId[]): Promise<void> => { await request<unknown>('PUT', '/watchlist', ids); },
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

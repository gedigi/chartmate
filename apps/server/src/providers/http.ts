import { NotFoundError, ProviderError } from '../errors.js';

export const REQUEST_TIMEOUT_MS = 15_000;

export interface HttpErrorInfo { status: number; body: unknown }

/**
 * GET JSON with a timeout. Network failures/timeouts and 429/418/5xx map to retryable
 * ProviderErrors; `mapError` may turn a specific failure into another error first.
 */
export async function getJson<T>(
  provider: string,
  fetchImpl: typeof fetch,
  url: string,
  opts: { headers?: Record<string, string>; mapError?: (e: HttpErrorInfo) => Error | undefined } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: opts.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(provider, `request failed: ${errMessage(err)}`, true);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderError(provider, `request failed: ${errMessage(err)}`, true, res.status);
  }
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ProviderError(provider, 'invalid JSON response', true, res.status);
  }
  if (res.ok && (body === null || body === undefined)) {
    throw new ProviderError(provider, 'invalid response: empty body', true, res.status);
  }
  if (!res.ok) {
    const mapped = opts.mapError?.({ status: res.status, body });
    if (mapped) throw mapped;
    const msg = `HTTP ${res.status}: ${bodyMessage(body) ?? res.statusText}`;
    if (res.status === 404) throw new NotFoundError(`${provider}: ${msg}`);
    const retryable = res.status === 429 || res.status === 418 || res.status >= 500;
    throw new ProviderError(provider, msg, retryable, res.status);
  }
  return body as T;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const m = o.msg ?? o.message;
    if (typeof m === 'string') return m;
  }
  if (typeof body === 'string' && body) return body.slice(0, 200);
  return undefined;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

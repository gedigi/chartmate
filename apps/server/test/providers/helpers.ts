import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function fixture<T = any>(rel: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)), 'utf8')) as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch fake: routes by predicate, records every URL requested. */
export function fakeFetch(handler: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    inits.push(init);
    return handler(url);
  }) as typeof fetch;
  return { impl, calls, inits };
}

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { isApiPath } from '../../../server/src/paths.js';
import { SECURITY_HEADERS } from './securityHeaders.js';

/** Same limit as the server's Fastify `bodyLimit` (apps/server/src/app.ts). */
export const API_BODY_LIMIT = 1024 * 1024;

export interface InjectRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: Buffer;
}

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  rawPayload: Buffer;
}

/** `fastify.inject` reduced to what the handler needs (kept structural so tests can fake it). */
export type InjectFn = (req: InjectRequest) => Promise<InjectResponse>;

export interface ProtocolOptions {
  inject: InjectFn;
  /** Absolute path of the built web UI (apps/web/dist). */
  webRoot: string;
  /** The only accepted host, e.g. `chartmate` for app://chartmate/…. */
  host: string;
  /** Called with internal failures (never sent to the renderer). */
  onError?: (err: unknown, url: string) => void;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Hop-by-hop / transport headers that must not be copied from an injected response. */
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'proxy-connection']);
/** Request headers never forwarded to Fastify (Chromium may add some; content-length is recomputed). */
const DROP_REQUEST_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

function withSecurityHeaders(h: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return h;
}

function plain(status: number, message: string): Response {
  const h = withSecurityHeaders(new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }));
  return new Response(message, { status, headers: h });
}

function apiError(status: number, code: string, message: string): Response {
  const h = withSecurityHeaders(new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
  return new Response(JSON.stringify({ code, message }), { status, headers: h });
}

/** Zero-copy view of a Buffer as a BodyInit. */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

class BodyTooLarge extends Error {}

/** Reads a request body, failing as soon as it exceeds `limit` bytes (never buffers more than limit + 1 chunk). */
async function readBody(req: Request, limit: number): Promise<Buffer | undefined> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  if (req.body === null) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Maps a URL path to a file under `webRoot`, or null when the path is not a safe, plain relative path.
 * Rejected: encoded separators (%2f, %5c), any backslash, NUL, undecodable escapes, `.`/`..` segments, and
 * anything that resolves outside the root (checked on the resolved path, with a trailing separator so
 * `/web-evil` cannot pass as a child of `/web`).
 */
export function resolveStaticPath(webRoot: string, rawPathname: string): string | null {
  if (/%2f|%5c|%00/i.test(rawPathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..')) return null;
  const root = resolve(webRoot);
  const full = resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

async function fileIfExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Handler for `protocol.handle('app', …)`: `/api/*` (as judged by the server's own `isApiPath`) goes through
 * `fastify.inject`; everything else is a read-only static file from the web build, with an SPA fallback to
 * index.html for extension-less paths. Every response carries the CSP and the other security headers.
 */
export function createAppProtocolHandler(opts: ProtocolOptions): (req: Request) => Promise<Response> {
  const root = resolve(opts.webRoot);
  const indexPath = resolve(root, 'index.html');

  async function serveFile(path: string, method: string, isIndex: boolean): Promise<Response> {
    const body = await readFile(path);
    const h = withSecurityHeaders(new Headers({ 'content-type': mimeType(path) }));
    const immutable = !isIndex && path.startsWith(resolve(root, 'assets') + sep);
    h.set('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return new Response(method === 'HEAD' ? null : bytes(body), { status: 200, headers: h });
  }

  async function handleApi(req: Request, url: URL): Promise<Response> {
    let payload: Buffer | undefined;
    try {
      payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, API_BODY_LIMIT);
    } catch (err) {
      if (err instanceof BodyTooLarge) return apiError(413, 'payload_too_large', 'Request body is too large');
      throw err;
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!DROP_REQUEST_HEADERS.has(k)) headers[k] = v;
    });
    const res = await opts.inject({
      method: req.method,
      url: url.pathname + url.search,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    const out = withSecurityHeaders(new Headers());
    for (const [k, v] of Object.entries(res.headers)) {
      const key = k.toLowerCase();
      if (v === undefined || DROP_RESPONSE_HEADERS.has(key) || key in SECURITY_HEADERS) continue;
      if (Array.isArray(v)) for (const item of v) out.append(key, item);
      else out.set(key, String(v));
    }
    out.set('cache-control', 'no-store');
    const nullBody = res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD';
    return new Response(nullBody ? null : bytes(res.rawPayload), { status: res.statusCode, headers: out });
  }

  return async (req: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return plain(404, 'Not found');
    }
    if (url.protocol !== 'app:' || url.host !== opts.host) return plain(404, 'Not found');
    const raw = url.pathname + url.search;
    try {
      if (isApiPath(raw)) return await handleApi(req, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
      const path = resolveStaticPath(root, url.pathname);
      if (path === null) return plain(404, 'Not found');
      if (path !== root && (await fileIfExists(path))) return await serveFile(path, req.method, path === indexPath);
      // SPA fallback, only for HTML navigations to extension-less paths: missing assets (x.js, y.css) and
      // non-navigation requests (fetch/XHR of e.g. /etc/passwd after URL normalization) stay 404.
      const last = url.pathname.split('/').pop() ?? '';
      const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
      if (path !== root && (last.includes('.') || !wantsHtml)) return plain(404, 'Not found');
      return await serveFile(indexPath, req.method, true);
    } catch (err) {
      opts.onError?.(err, `${req.method} ${url.pathname}`);
      return isApiPath(raw) ? apiError(500, 'internal', 'Internal error') : plain(500, 'Internal error');
    }
  };
}

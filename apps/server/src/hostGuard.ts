import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isApiPath } from './paths.js';

/** Always allowed, on any port: the loopback names a browser on the same machine uses. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Letters, digits, hyphens and underscores (Docker and Compose service names may contain `_`).
const LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
/** A DNS name or an IPv4 address (both are dot-separated labels of this alphabet). */
const NAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
/** A bracketed IPv6 literal, as it appears in a Host header or a URL. */
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;

function normalizeName(raw: string): string | null {
  const h = raw.toLowerCase().replace(/\.$/, '');
  return NAME_RE.test(h) || IPV6_RE.test(h) ? h : null;
}

/**
 * The hostname of a Host header value (`name[:port]`, `[v6][:port]`), lowercased, without a trailing dot; null
 * when the value is not a plain host with an optional numeric port.
 */
export function hostnameOf(host: string): string | null {
  return parseHost(host)?.name ?? null;
}

/** A Host header value split into its normalized name and its explicit port (undefined when none is given). */
function parseHost(host: string): { name: string; port: string | undefined } | null {
  let name: string;
  let port: string | undefined;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    name = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      port = rest.slice(1);
    }
  } else {
    const parts = host.split(':');
    if (parts.length > 2) return null;
    name = parts[0]!;
    port = parts[1];
  }
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return null;
  const normalized = normalizeName(name);
  return normalized === null ? null : { name: normalized, port: port === undefined ? undefined : String(Number(port)) };
}

/**
 * `CHARTMATE_ALLOWED_HOSTS`: comma-separated hostnames, IPv4 addresses or bracketed IPv6 addresses, without a
 * scheme, port or wildcard. Blank entries are ignored. Throws on anything else.
 */
export function parseAllowedHosts(value: string | undefined): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  for (const entry of value.split(',')) {
    const e = entry.trim();
    if (e === '') continue;
    const name = normalizeName(e);
    if (name === null) {
      throw new Error(
        `Invalid configuration: CHARTMATE_ALLOWED_HOSTS: "${e}" is not a hostname or IP address ` +
        '(no scheme, port or wildcard; IPv6 in brackets)',
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function isAllowedHostname(hostname: string, allowed: readonly string[]): boolean {
  return LOOPBACK.has(hostname) || allowed.includes(hostname);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface HostGuardOptions {
  password: string | null;
  /** Extra allowed hostnames (`CHARTMATE_ALLOWED_HOSTS`), already normalized. */
  allowedHosts: readonly string[];
  /** Exact origins accepted on state-changing API requests besides the request's own (desktop: app://chartmate). */
  allowedOrigins: readonly string[];
  /** Whether a proxy is trusted (`CHARTMATE_TRUST_PROXY`): then X-Forwarded-Host is checked too. */
  trustProxy: boolean;
}

const headerValues = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(',')).map((x) => x.trim());

/**
 * Whether the Origin of a state-changing request is the request's own origin. Accepted: a browser-set
 * `Sec-Fetch-Site: same-origin` (pages cannot forge it); an Origin with the same hostname and port as the
 * request's host (no explicit port on the host means a default port, so the Origin must not name one); a
 * configured exact origin; or, for a loopback host only, a loopback Origin on any port (the Vite dev server on
 * :5173 proxying to :8787).
 */
function originMatches(request: FastifyRequest, origin: string, allowedOrigins: readonly string[]): boolean {
  if (request.headers['sec-fetch-site'] === 'same-origin') return true;
  if (allowedOrigins.includes(origin.toLowerCase())) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const o = parseHost(url.host);
  const h = parseHost(request.host);
  if (o === null || h === null) return false;
  if (LOOPBACK.has(h.name) && LOOPBACK.has(o.name)) return true;
  if (o.name !== h.name) return false;
  return h.port === undefined ? o.port === undefined : o.port === h.port || (o.port === undefined && isDefaultPort(url.protocol, h.port));
}

function isDefaultPort(protocol: string, port: string): boolean {
  return (protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443');
}

/**
 * Two checks, registered before every other hook so they run ahead of auth, the API routes and the static files:
 * - Host: without a password (or with one when a list is configured), the Host header, and behind a trusted
 *   proxy every X-Forwarded-Host entry too, must be an allowed name. This stops DNS rebinding: a page on
 *   another site that points its own name at this server is refused.
 * - Origin: a state-changing API request (not GET/HEAD/OPTIONS) that carries an Origin must come from the
 *   request's own origin (see originMatches), with or without a password.
 * - Fetch metadata: an API request a browser marks `Sec-Fetch-Site` other than `same-origin` or `none` (typed
 *   URL) is refused, whatever its method. Requests without the header (scripts, the desktop app) pass.
 */
export function registerHostGuard(app: FastifyInstance, opts: HostGuardOptions): void {
  const checkHost = opts.password === null || opts.allowedHosts.length > 0;
  const allowed = opts.allowedHosts;
  const allowedOrigins = opts.allowedOrigins.map((o) => o.toLowerCase());

  const deny = (request: FastifyRequest, reply: FastifyReply, code: string, message: string) => {
    if (isApiPath(request.url)) return reply.code(403).send({ code, message });
    return reply.code(403).type('text/plain; charset=utf-8').send(message);
  };
  const ok = (host: string) => {
    const name = hostnameOf(host);
    return name !== null && isAllowedHostname(name, allowed);
  };

  app.addHook('onRequest', async (request, reply) => {
    if (checkHost) {
      // The raw Host and, when a proxy is trusted, every forwarded host: Fastify's request.host alone would take
      // a client-sent X-Forwarded-Host over a foreign Host.
      const hosts = [request.headers.host ?? '', ...(opts.trustProxy ? headerValues(request.headers['x-forwarded-host']) : [])];
      if (!hosts.every(ok)) {
        return deny(request, reply, 'host_not_allowed',
          'Host not allowed. Add this hostname to CHARTMATE_ALLOWED_HOSTS (and set CHARTMATE_PASSWORD) to serve it.');
      }
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !SAFE_METHODS.has(request.method) && isApiPath(request.url)
      && !originMatches(request, origin, allowedOrigins)) {
      return deny(request, reply, 'origin_not_allowed', 'Origin not allowed.');
    }
    // A browser marks every request with Sec-Fetch-Site (pages cannot forge it). The app only calls its own API,
    // so an API request another site's page caused (an <img>, a script, a no-cors fetch) is refused before it
    // reaches a provider: without a password such GETs would otherwise burn the provider quota.
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && isApiPath(request.url)) {
      return deny(request, reply, 'cross_site', 'Cross-site API requests are not allowed.');
    }
  });
}

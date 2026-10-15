import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isApiPath } from './paths.js';

/** Always allowed, on any port: the loopback names a browser on the same machine uses. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
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
  return normalizeName(name);
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
}

/**
 * Rejects requests whose Host (or, behind a trusted proxy, X-Forwarded-Host) is not an allowed name, so a page on
 * another site cannot reach the server through DNS rebinding; and state-changing API requests whose Origin, when
 * sent, is not an allowed name. Active without a password, or with one when a list is configured. Registered
 * before every other hook, so it runs ahead of auth, the API routes and the static files.
 */
export function registerHostGuard(app: FastifyInstance, opts: HostGuardOptions): void {
  if (opts.password !== null && opts.allowedHosts.length === 0) return;
  const allowed = opts.allowedHosts;

  const deny = (request: FastifyRequest, reply: FastifyReply, code: string, message: string) => {
    if (isApiPath(request.url)) return reply.code(403).send({ code, message });
    return reply.code(403).type('text/plain; charset=utf-8').send(message);
  };

  app.addHook('onRequest', async (request, reply) => {
    // Fastify's `host` honors X-Forwarded-Host only when the connecting address is a trusted proxy.
    const hostname = hostnameOf(request.host);
    if (hostname === null || !isAllowedHostname(hostname, allowed)) {
      return deny(request, reply, 'host_not_allowed',
        'Host not allowed. Add this hostname to CHARTMATE_ALLOWED_HOSTS (and set CHARTMATE_PASSWORD) to serve it.');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !SAFE_METHODS.has(request.method) && isApiPath(request.url)) {
      let originHost: string | null = null;
      try {
        originHost = hostnameOf(new URL(origin).host);
      } catch {
        originHost = null;
      }
      if (originHost === null || !isAllowedHostname(originHost, allowed)) {
        return deny(request, reply, 'origin_not_allowed', 'Origin not allowed.');
      }
    }
  });
}

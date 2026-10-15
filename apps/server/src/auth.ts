import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodedPath, isApiPath, looksLikeApi } from './paths.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session even when a password is set. */
    public?: boolean;
    /** Static/SPA asset route (public unless the decoded path is under /api). */
    spa?: boolean;
  }
}

/** Session cookie over plain http. */
export const SESSION_COOKIE = 'chartmate_session';
/**
 * Session cookie over https: the `__Host-` prefix makes the browser insist on Secure, Path=/ and no Domain, so
 * neither a sibling subdomain nor a plain-http page can plant or overwrite it.
 */
export const SECURE_SESSION_COOKIE = '__Host-chartmate_session';
const DAY = 86_400_000;
export const SESSION_MAX_AGE_MS = 30 * DAY;
const CLOCK_SKEW_MS = 5 * 60_000;
const COOKIE_RE = /^v2\.(\d{1,15})\.([A-Za-z0-9_-]{22})$/;

export interface AuthOptions { password: string | null; sessionSecret: string; now: () => number }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Binds a session to the password it was issued for: an HMAC of the password under the session secret (128 bits).
 * Changing the password changes it, which revokes every existing session. Keyed by the secret, so a leaked cookie
 * gives nothing to guess the password from offline.
 */
export function passwordFingerprint(password: string, secret: string): string {
  return createHmac('sha256', secret).update(`chartmate-session:${password}`, 'utf8').digest('base64url').slice(0, 22);
}

/** Valid signed `v2.<issuedAtMs>.<fingerprint>` cookie, issued within the last 30 days. Always true without a password. */
export function isAuthenticated(request: FastifyRequest, opts: AuthOptions): boolean {
  if (opts.password === null) return true;
  // The plain name is still read over https (sessions issued before the server was put behind https).
  return isValidSession(request, request.cookies[SECURE_SESSION_COOKIE], opts)
    || isValidSession(request, request.cookies[SESSION_COOKIE], opts);
}

function isValidSession(request: FastifyRequest, raw: string | undefined, opts: AuthOptions): boolean {
  if (!raw || opts.password === null) return false;
  const r = request.unsignCookie(raw);
  if (!r.valid || r.value === null) return false;
  const m = COOKIE_RE.exec(r.value);
  if (!m) return false;
  const expected = Buffer.from(passwordFingerprint(opts.password, opts.sessionSecret));
  if (!timingSafeEqual(Buffer.from(m[2]!), expected)) return false;
  const issuedAt = Number(m[1]);
  const now = opts.now();
  return issuedAt <= now + CLOCK_SKEW_MS && now - issuedAt <= SESSION_MAX_AGE_MS;
}

const secureRequest = (request: FastifyRequest) => request.protocol === 'https';

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, opts: AuthOptions): void {
  if (opts.password === null) return;
  const secure = secureRequest(request);
  reply.setCookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE,
    `v2.${opts.now()}.${passwordFingerprint(opts.password, opts.sessionSecret)}`, {
      signed: true, httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: SESSION_MAX_AGE_MS / 1000,
    });
}

/** Clears the session cookie under both names. */
export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  const secure = secureRequest(request);
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure });
  if (secure) reply.clearCookie(SECURE_SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: true });
}

/**
 * Deny-by-default guard keyed on the matched route: public only if the route is marked
 * `config.public`, or it is the SPA/static route or the not-found handler for a non-/api decoded path.
 */
export function isPublicRequest(request: FastifyRequest): boolean {
  if (request.routeOptions.config?.public === true) return true;
  const spaOr404 = request.routeOptions.config?.spa === true || request.is404;
  return spaOr404 && !isApiPath(request.url);
}

/** Registers cookie support and the guard when a password is configured; no-op otherwise. */
export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  if (opts.password === null) return;
  await app.register(cookie, { secret: opts.sessionSecret });
  app.addHook('onRequest', async (request, reply) => {
    if (decodedPath(request.url) === null) {
      // Fail closed on undecodable paths.
      if (looksLikeApi(request.url)) return reply.code(401).send({ code: 'unauthorized', message: 'Login required' });
      return reply.code(400).send({ code: 'invalid_request', message: 'Malformed URL' });
    }
    if (isPublicRequest(request)) return;
    if (isAuthenticated(request, opts)) return;
    return reply.code(401).send({ code: 'unauthorized', message: 'Login required' });
  });
}

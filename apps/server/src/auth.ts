import { createHash, timingSafeEqual } from 'node:crypto';
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

export const SESSION_COOKIE = 'altv_session';
const DAY = 86_400_000;
export const SESSION_MAX_AGE_MS = 30 * DAY;
const CLOCK_SKEW_MS = 5 * 60_000;
const COOKIE_RE = /^v1\.(\d{1,15})$/;

export interface AuthOptions { password: string | null; sessionSecret: string; now: () => number }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Valid signed `v1.<issuedAtMs>` cookie, issued within the last 30 days. Always true without a password. */
export function isAuthenticated(request: FastifyRequest, opts: AuthOptions): boolean {
  if (opts.password === null) return true;
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const r = request.unsignCookie(raw);
  if (!r.valid || r.value === null) return false;
  const m = COOKIE_RE.exec(r.value);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  const now = opts.now();
  return issuedAt <= now + CLOCK_SKEW_MS && now - issuedAt <= SESSION_MAX_AGE_MS;
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, now: number): void {
  reply.setCookie(SESSION_COOKIE, `v1.${now}`, {
    signed: true, httpOnly: true, sameSite: 'lax', path: '/', secure: request.protocol === 'https',
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: request.protocol === 'https' });
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

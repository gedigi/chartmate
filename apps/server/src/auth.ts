import { createHash, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'altv_session';
const MAX_AGE_S = 30 * 24 * 60 * 60;
/** Exact paths reachable without a session. */
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/session', '/api/login']);

export interface AuthOptions { password: string | null; sessionSecret: string }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function isAuthenticated(request: FastifyRequest, opts: AuthOptions): boolean {
  if (opts.password === null) return true;
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const r = request.unsignCookie(raw);
  return r.valid && r.value === '1';
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, '1', {
    signed: true, httpOnly: true, sameSite: 'lax', path: '/', secure: request.protocol === 'https', maxAge: MAX_AGE_S,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: request.protocol === 'https' });
}

/** Path of a request URL without its query string. */
function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** Registers cookie support and the `/api/*` guard when a password is configured; no-op otherwise. */
export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  if (opts.password === null) return;
  await app.register(cookie, { secret: opts.sessionSecret });
  app.addHook('onRequest', async (request, reply) => {
    const path = pathOf(request.url);
    if (!(path === '/api' || path.startsWith('/api/'))) return;
    if (PUBLIC_API_PATHS.has(path)) return;
    if (isAuthenticated(request, opts)) return;
    return reply.code(401).send({ code: 'unauthorized', message: 'Login required' });
  });
}

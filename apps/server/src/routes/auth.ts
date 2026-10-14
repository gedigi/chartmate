import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, isAuthenticated, passwordMatches, setSessionCookie, type AuthOptions } from '../auth.js';
import { LoginLimiter } from '../loginLimiter.js';
import { parse } from './validation.js';

const LoginBody = z.object({ password: z.string().max(1024) });
const PUBLIC = { config: { public: true } };

export async function authRoutes(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const limiter = new LoginLimiter(opts.now);

  app.get('/api/session', PUBLIC, async (request) => ({
    authRequired: opts.password !== null,
    authenticated: isAuthenticated(request, opts),
  }));

  app.post('/api/login', PUBLIC, async (request, reply) => {
    const { password } = parse(LoginBody, request.body);
    if (opts.password === null) return reply.code(204).send();
    if (limiter.blocked(request.ip)) {
      return reply.code(429).send({ code: 'rate_limited', message: 'Too many failed logins; try again later' });
    }
    if (!passwordMatches(password, opts.password)) {
      limiter.recordFailure(request.ip);
      return reply.code(401).send({ code: 'unauthorized', message: 'Wrong password' });
    }
    limiter.reset(request.ip);
    setSessionCookie(request, reply, opts.now());
    return reply.code(204).send();
  });

  app.post('/api/logout', PUBLIC, async (request, reply) => {
    if (opts.password !== null) clearSessionCookie(request, reply);
    return reply.code(204).send();
  });
}

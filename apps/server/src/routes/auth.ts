import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, isAuthenticated, passwordMatches, setSessionCookie, type AuthOptions } from '../auth.js';
import { parse } from './validation.js';

const LoginBody = z.object({ password: z.string().max(1024) });

export async function authRoutes(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  app.get('/api/session', async (request) => ({
    authRequired: opts.password !== null,
    authenticated: isAuthenticated(request, opts),
  }));

  app.post('/api/login', async (request, reply) => {
    const { password } = parse(LoginBody, request.body);
    if (opts.password === null) return reply.code(204).send();
    if (!passwordMatches(password, opts.password)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Wrong password' });
    }
    setSessionCookie(request, reply);
    return reply.code(204).send();
  });

  app.post('/api/logout', async (request, reply) => {
    if (opts.password !== null) clearSessionCookie(request, reply);
    return reply.code(204).send();
  });
}

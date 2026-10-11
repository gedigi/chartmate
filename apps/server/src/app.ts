import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAuth } from './auth.js';
import type { BasketService } from './baskets/service.js';
import type { Config } from './config.js';
import type { Repos } from './db/repos.js';
import { AppError, ProviderError } from './errors.js';
import type { MarketDataService } from './market/service.js';
import { authRoutes } from './routes/auth.js';
import { basketRoutes } from './routes/baskets.js';
import { marketRoutes } from './routes/market.js';
import { userRoutes } from './routes/user.js';

const BODY_LIMIT = 1024 * 1024;

export interface AppDeps { config: Config; repos: Repos; market: MarketDataService; baskets: BasketService; logger?: boolean }

function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid request';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

const isApiPath = (url: string) => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, repos, market, baskets } = deps;
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, bodyLimit: BODY_LIMIT });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ code: 'invalid_request', message: zodMessage(error) });
    }
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.warn({ err: error }, 'request failed');
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof ProviderError) {
      request.log.warn({ err: error }, 'provider unavailable');
      return reply.code(503).send({ code: 'provider_unavailable', message: 'Market data provider unavailable' });
    }
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : 'Invalid request';
      return reply.code(status).send({ code: 'invalid_request', message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ code: 'internal', message: 'Internal error' });
  });

  const authOpts = { password: config.password, sessionSecret: config.sessionSecret };
  await registerAuth(app, authOpts);

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes, authOpts);
  await app.register(marketRoutes, { market, baskets });
  await app.register(basketRoutes, { baskets });
  await app.register(userRoutes, { repos });

  const webDist = config.webDist;
  if (webDist) await app.register(fastifyStatic, { root: webDist, prefix: '/' });

  app.setNotFoundHandler((request, reply) => {
    if (webDist && (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url)) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ code: 'not_found', message: `Route ${request.method} ${request.url.split('?')[0]} not found` });
  });

  return app;
}

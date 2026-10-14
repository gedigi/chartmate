import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions,
} from 'fastify';
import { ZodError } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { registerAuth } from './auth.js';
import type { BasketService } from './baskets/service.js';
import type { Config } from './config.js';
import type { Repos } from './db/repos.js';
import { AppError, ProviderError } from './errors.js';
import type { MarketDataService } from './market/service.js';
import { decodedPath, isApiPath, looksLikeApi } from './paths.js';
import { authRoutes } from './routes/auth.js';
import { basketRoutes } from './routes/baskets.js';
import { marketRoutes } from './routes/market.js';
import { userRoutes } from './routes/user.js';

const BODY_LIMIT = 1024 * 1024;

export interface AppDeps {
  config: Config; repos: Repos; market: MarketDataService; baskets: BasketService;
  /** Fastify logger: true/false, or pino options (the desktop app passes a level + file stream). */
  logger?: FastifyServerOptions['logger'];
  /** Clock for session expiry and login rate limiting. */
  now?: () => number;
}

function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid request';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Hop counts are expressed as a function (Fastify's typings omit the numeric form). */
function toFastifyTrustProxy(tp: Config['trustProxy']): boolean | string | ((addr: string, hop: number) => boolean) {
  return typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp;
}

/**
 * Router-level failures (e.g. undecodable URL) never reach onRequest hooks: fail closed here. Messages are mapped by
 * Fastify error code so internal details never leak.
 */
export function frameworkErrorHandler(password: string | null) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (password !== null && looksLikeApi(request.url)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Login required' });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400;
    const message = error.code === 'FST_ERR_BAD_URL' ? 'Malformed URL' : 'Bad request';
    return reply.code(status).send({ code: 'invalid_request', message });
  };
}

/**
 * The SPA's index.html, read once at startup and kept in memory; re-read only when its mtime changes (a rebuilt web
 * bundle is picked up without a restart). `get()` resolves to null when the file is missing/unreadable.
 */
class IndexHtml {
  private html: Buffer | null = null;
  private mtimeMs = -1;
  constructor(private readonly path: string) {}

  async get(): Promise<Buffer | null> {
    let m: number;
    try {
      m = (await stat(this.path)).mtimeMs;
    } catch {
      this.html = null;
      this.mtimeMs = -1;
      return null;
    }
    if (this.html === null || m !== this.mtimeMs) {
      try {
        this.html = await readFile(this.path);
        this.mtimeMs = m;
      } catch {
        this.html = null;
        this.mtimeMs = -1;
      }
    }
    return this.html;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, repos, market, baskets } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: toFastifyTrustProxy(config.trustProxy),
    bodyLimit: BODY_LIMIT,
    frameworkErrors: frameworkErrorHandler(config.password),
  });

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

  const authOpts = { password: config.password, sessionSecret: config.sessionSecret, now: deps.now ?? Date.now };
  await registerAuth(app, authOpts);

  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));
  await app.register(authRoutes, authOpts);
  await app.register(marketRoutes, { market, baskets, ...(deps.now ? { now: deps.now } : {}) });
  await app.register(basketRoutes, { baskets });
  await app.register(userRoutes, { repos });

  const webDist = config.webDist;
  const indexHtml = webDist ? new IndexHtml(join(webDist, 'index.html')) : null;
  await indexHtml?.get(); // read once at startup (missing is tolerated)
  if (webDist) {
    // Encapsulated so only the static plugin's routes get tagged as SPA routes (see auth guard).
    await app.register(async (scope) => {
      scope.addHook('onRoute', (route) => { route.config = { ...route.config, spa: true }; });
      // Static/SPA routes never answer API-looking paths (e.g. `/\api/x`, `/api;x/y`): JSON 404 instead.
      scope.addHook('onRequest', async (request, reply) => {
        if (isApiPath(request.url)) return reply.callNotFound();
      });
      await scope.register(fastifyStatic, { root: webDist, prefix: '/' });
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (indexHtml && (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url)) {
      const html = await indexHtml.get();
      if (html === null) {
        return reply.code(404).send({ code: 'web_not_built', message: 'Web UI not built (index.html missing)' });
      }
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
    }
    const path = decodedPath(request.url) ?? request.url.split('?')[0];
    return reply.code(404).send({ code: 'not_found', message: `Route ${request.method} ${path} not found` });
  });

  return app;
}

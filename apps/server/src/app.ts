import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions,
} from 'fastify';
import { ZodError } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { registerAuth } from './auth.js';
import { registerHostGuard } from './hostGuard.js';
import { registerSecurityHeaders } from './securityHeaders.js';
import type { BasketService } from './baskets/service.js';
import type { Config } from './config.js';
import type { Repos } from './db/repos.js';
import { AppError, ProviderError } from './errors.js';
import type { MarketDataService } from './market/service.js';
import { decodedPath, isApiPath, looksLikeApi } from './paths.js';
import { authRoutes } from './routes/auth.js';
import { basketRoutes } from './routes/baskets.js';
import { marketRoutes } from './routes/market.js';
import { syncRoutes } from './routes/sync.js';
import { alertRoutes } from './routes/alerts.js';
import { AlertService, type AlertNotification } from './alerts/service.js';
import { userRoutes } from './routes/user.js';
import type { GitHubTarget } from './sync/github.js';
import type { AppAuth } from './sync/githubAuth.js';
import { SyncService, type RemoteStore, type SecretCipher } from './sync/service.js';

const BODY_LIMIT = 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A file of the web build's `assets/` directory (Vite's content-hashed bundles). */
function isHashedAsset(webDist: string, path: string): boolean {
  const rel = relative(webDist, path);
  return rel.startsWith(`assets${sep}`) && !rel.includes('..');
}

/** A path under /assets/, or whose last segment has a file extension: a static file, never an SPA route. */
function looksLikeFile(url: string): boolean {
  const path = decodedPath(url) ?? url.split('?')[0]!;
  if (/^\/assets(\/|$)/.test(path)) return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(last);
}

export interface AppDeps {
  config: Config; repos: Repos; market: MarketDataService; baskets: BasketService;
  /** Fastify logger: true/false, or pino options (the desktop app passes a level + file stream). */
  logger?: FastifyServerOptions['logger'];
  /** Clock for session expiry and login rate limiting. */
  now?: () => number;
  /** The version `GET /api/about` reports (the server's own, or the desktop app's); null/absent = unknown. */
  version?: string | null;
  /** Encrypts the stored sync token (the desktop app: the OS keychain); absent = stored as is. */
  syncCipher?: SecretCipher | null;
  /** The sync file's store (tests: a fake); absent = the GitHub repository. */
  syncRemote?: (t: GitHubTarget) => RemoteStore;
  /** GitHub sign-in for sync (tests: a fake; the desktop app: one on its sync-only fetch); absent = GitHub. */
  syncAuth?: AppAuth;
  /** Shows an alert to the user (the desktop app: a native notification). Absent: alerts are not checked here. */
  alertNotify?: (n: AlertNotification) => void;
  /** How often alerts are checked (tests). */
  alertIntervalMs?: number;
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
      else if (error.cause !== undefined) request.log.info({ err: error.cause }, error.message);
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

  registerSecurityHeaders(app);
  // First hook: a request for a host that is not allowed never reaches auth, the API or the static files.
  registerHostGuard(app, {
    password: config.password, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
    trustProxy: config.trustProxy !== false,
  });

  // Without CHARTMATE_SESSION_SECRET the secret is random, generated once and kept in the database (never derived
  // from the password, so a leaked cookie gives nothing to guess the password from).
  const sessionSecret = config.password === null ? '' : config.sessionSecret ?? await repos.settings.sessionSecret();
  const authOpts = { password: config.password, sessionSecret, now: deps.now ?? Date.now };
  await registerAuth(app, authOpts);

  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));
  // Behind the login like the rest of the API: the About dialog shows it, nobody else needs it.
  app.get('/api/about', async () => ({ version: deps.version ?? null }));
  await app.register(authRoutes, authOpts);
  await app.register(marketRoutes, { market, baskets, ...(deps.now ? { now: deps.now } : {}) });
  await app.register(basketRoutes, { baskets });
  await app.register(userRoutes, { repos });
  const sync = new SyncService({
    repos, baskets, env: config.sync ?? null, cipher: deps.syncCipher ?? null,
    ...(deps.syncRemote ? { remote: deps.syncRemote } : {}), ...(deps.syncAuth ? { auth: deps.syncAuth } : {}), ...(deps.now ? { now: deps.now } : {}),
  });
  sync.start();
  app.addHook('onClose', async () => sync.stop());
  await app.register(syncRoutes, { sync });

  const alerts = deps.alertNotify
    ? new AlertService({
      repos, market, baskets, notify: deps.alertNotify,
      ...(deps.now ? { now: deps.now } : {}), ...(deps.alertIntervalMs ? { intervalMs: deps.alertIntervalMs } : {}),
    })
    : null;
  alerts?.start();
  // Waits for a check still running: the database is closed after the app.
  app.addHook('onClose', async () => { await alerts?.stop(); });
  await app.register(alertRoutes, { alerts });

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
      await scope.register(fastifyStatic, {
        root: webDist, prefix: '/', dotfiles: 'deny', cacheControl: false,
        // Vite's hashed bundles under /assets never change; everything else (index.html, theme-init.js) is revalidated.
        setHeaders: (reply: FastifyReply, path: string) => {
          reply.header('cache-control', isHashedAsset(webDist, path) ? IMMUTABLE : 'no-cache');
        },
      });
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (indexHtml && (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url)) {
      // A missing bundle file (e.g. an old hashed asset after an upgrade) is a 404, never the page: a script or
      // stylesheet answered with HTML would only fail later, and confusingly.
      if (looksLikeFile(request.url)) {
        return reply.code(404).header('cache-control', 'no-cache').type('text/plain; charset=utf-8').send('Not found');
      }
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

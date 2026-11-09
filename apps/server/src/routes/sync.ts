import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { SyncRemoteError } from '../sync/github.js';
import type { SyncService } from '../sync/service.js';
import { parse } from './validation.js';

const ConfigureBody = z.object({ repo: z.string().max(200), token: z.string().max(500) });

/**
 * Sync settings and runs. The token goes in once (PUT) and never comes back out: status reports the repository, the
 * last sync and the last error only.
 */
export async function syncRoutes(app: FastifyInstance, deps: { sync: SyncService }): Promise<void> {
  const { sync } = deps;
  const failed = (e: unknown, status = 502): never => {
    if (e instanceof SyncRemoteError) throw new AppError(status, 'sync_failed', e.message);
    throw e;
  };

  app.get('/api/sync', async () => sync.status());

  app.put('/api/sync', async (request) => {
    const { repo, token } = parse(ConfigureBody, request.body);
    return sync.configure(repo, token).catch((e: unknown) => failed(e, 400));
  });

  app.delete('/api/sync', async (_request, reply) => {
    await sync.disconnect().catch((e: unknown) => failed(e, 400));
    return reply.code(204).send();
  });

  // A full sync (the web app runs it as it loads, before it reads the data). null: sync is off.
  app.post('/api/sync/run', async () => sync.sync('full').catch((e: unknown) => failed(e)));

  // Whether another device saved newer data (an open page offers a reload). null: sync is off.
  app.get('/api/sync/check', async () => sync.check().catch((e: unknown) => failed(e)));
}

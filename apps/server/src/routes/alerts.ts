import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlertService } from '../alerts/service.js';
import { parse } from './validation.js';

const IdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Alerts on drawings. Their settings are part of the drawings (saved with them); here: whether this host checks them
 * (`supported`: the desktop app, which can notify), how each one stands, and re-arming a fired one.
 */
export async function alertRoutes(app: FastifyInstance, deps: { alerts: AlertService | null }): Promise<void> {
  const { alerts } = deps;
  app.get('/api/alerts', async () => ({ supported: alerts !== null, alerts: alerts ? await alerts.statuses() : {} }));
  app.post('/api/alerts/:id/rearm', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await alerts?.rearm(id);
    return reply.code(204).send();
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlertService } from '../alerts/service.js';
import { NotFoundError } from '../errors.js';
import { parse } from './validation.js';

const IdParams = z.object({ id: z.string().min(1).max(64) });
const PatchBody = z.object({ on: z.boolean() });

/**
 * Alerts on drawings. Their settings are part of the drawings (saved with them); here: whether this host checks them
 * (`supported`: the desktop app, which can notify), how each one stands, and re-arming a fired one.
 */
export async function alertRoutes(app: FastifyInstance, deps: { alerts: AlertService | null }): Promise<void> {
  const { alerts } = deps;
  app.get('/api/alerts', async () => (alerts
    ? { supported: true, alerts: await alerts.statuses(), list: await alerts.list() }
    : { supported: false, alerts: {}, list: [] }));
  // Switch an alert on or off, or remove it, where its drawing is stored (the Alerts panel, for symbols not on screen).
  app.patch('/api/alerts/:id', async (request) => {
    const { id } = parse(IdParams, request.params);
    const { on } = parse(PatchBody, request.body);
    if (!alerts || !(await alerts.update(id, { on }))) throw new NotFoundError('No such alert');
    return { ok: true };
  });
  app.delete('/api/alerts/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    if (!alerts || !(await alerts.update(id, null))) throw new NotFoundError('No such alert');
    return reply.code(204).send();
  });
  app.post('/api/alerts/:id/rearm', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await alerts?.rearm(id);
    return reply.code(204).send();
  });
}

import { MAX_BASKET_SYMBOLS, MAX_BASKET_VERSIONS, MAX_CONSTITUENTS, tryNormalizeSymbolId, type Basket } from '@chartmate/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BasketService } from '../baskets/service.js';
import { parse } from './validation.js';

// Shape only; semantic validation (dates, weights, constituents) is BasketService's job → 400 invalid_basket.
const VersionSchema = z.object({
  effectiveFrom: z.string().max(10),
  weights: z.record(z.string().max(100), z.number()).refine((w) => Object.keys(w).length <= MAX_CONSTITUENTS, {
    message: `A version may have at most ${MAX_CONSTITUENTS} constituents`,
  }).transform(normalizeWeightKeys),
});

/**
 * Constituent ids normalized (`stock:aapl` → `stock:AAPL`; case variants of one symbol are summed). An invalid id is
 * kept as sent, so the service reports it as an invalid constituent.
 */
function normalizeWeightKeys(w: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) {
    const id = tryNormalizeSymbolId(k) ?? k;
    out[id] = id in out ? out[id]! + v : v;
  }
  return out;
}
const Versions = z.array(VersionSchema).max(MAX_BASKET_VERSIONS, { message: `A basket may have at most ${MAX_BASKET_VERSIONS} versions` })
  .refine((vs) => new Set(vs.flatMap((v) => Object.keys(v.weights))).size <= MAX_BASKET_SYMBOLS, {
    message: `A basket may hold at most ${MAX_BASKET_SYMBOLS} different symbols across its versions`,
  });
const CreateBody = z.object({
  name: z.string().max(200),
  baseValue: z.number().optional(),
  versions: Versions,
});
const UpdateBody = z.object({ name: z.string().max(200).optional(), versions: Versions.optional() });
const IdParams = z.object({ id: z.string().min(1).max(100) });

export async function basketRoutes(app: FastifyInstance, deps: { baskets: BasketService }): Promise<void> {
  const { baskets } = deps;

  app.get('/api/baskets', async (): Promise<Basket[]> => baskets.list());

  app.post('/api/baskets', async (request, reply) => {
    const body = parse(CreateBody, request.body);
    const created = await baskets.create(body);
    return reply.code(201).send(created);
  });

  app.get('/api/baskets/:id', async (request): Promise<Basket> => baskets.get(parse(IdParams, request.params).id));

  app.put('/api/baskets/:id', async (request): Promise<Basket> => {
    const { id } = parse(IdParams, request.params);
    return baskets.update(id, parse(UpdateBody, request.body));
  });

  app.post('/api/baskets/:id/versions', async (request): Promise<Basket> => {
    const { id } = parse(IdParams, request.params);
    return baskets.appendVersion(id, parse(VersionSchema, request.body));
  });

  app.delete('/api/baskets/:id', async (request, reply) => {
    await baskets.delete(parse(IdParams, request.params).id);
    return reply.code(204).send();
  });
}

import type { Basket, SymbolId } from '@chartmate/shared';
import { z } from 'zod';
import type { BasketService } from '../baskets/service.js';
import type { Repos } from '../db/repos.js';
import { Versions } from '../routes/baskets.js';
import { DrawingsBody, LayoutKey, LayoutSchema, WatchlistEntries } from '../routes/user.js';
import { SymbolIdSchema } from '../routes/validation.js';
import type { DocState, Docs } from './merge.js';

/**
 * The synced user data as documents: `watchlist`, `layout:<key>`, `drawings:<symbol>`, `basket:<id>`. Everything
 * read from the sync file is validated with the API's own schemas before it is written: the file is the user's, but
 * a broken or hand-edited one must never put data here the app would refuse from itself.
 */

const BasketDoc = z.object({
  name: z.string().trim().min(1).max(200),
  baseValue: z.number().finite().positive(),
  versions: Versions,
  createdAt: z.number().int().nonnegative(),
});
const BasketId = z.string().min(1).max(100);

/** This device's documents, each with its stamp. */
export async function collectLocal(repos: Repos): Promise<Docs> {
  const docs: Docs = {};
  const [watchlistAt, watchlist, stored, layouts, drawings, baskets] = await Promise.all([
    repos.watchlist.updatedAt(), repos.watchlist.list(), repos.watchlist.stored(),
    repos.layouts.list(), repos.drawings.list(), repos.baskets.list(),
  ]);
  // A watchlist never saved is not a document (a new device must not push its seed list over a real one).
  if (stored) docs.watchlist = { t: watchlistAt, v: watchlist };
  for (const l of layouts) docs[`layout:${l.key}`] = { t: l.updatedAt, v: l.layout };
  for (const d of drawings) docs[`drawings:${d.symbol}`] = { t: d.updatedAt, v: d.drawings };
  for (const b of baskets) {
    const value: z.input<typeof BasketDoc> = { name: b.name, baseValue: b.baseValue, versions: b.versions, createdAt: b.createdAt };
    docs[`basket:${b.id}`] = { t: b.updatedAt, v: value };
  }
  return docs;
}

/** The keys this device syncs (anything else in the file is kept there but never applied). */
export function isSyncKey(key: string): boolean {
  if (key === 'watchlist') return true;
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (kind === 'layout') return LayoutKey.safeParse({ key: id }).success;
  if (kind === 'drawings') return SymbolIdSchema.safeParse(id).success;
  if (kind === 'basket') return BasketId.safeParse(id).success;
  return false;
}

/**
 * Writes remote winners here with their stamps. A document that fails validation is skipped (its key returned), and
 * so is a deletion of anything but a basket (layouts, drawings and the watchlist are never deleted, only emptied).
 */
export async function applyRemote(repos: Repos, baskets: BasketService, docs: Docs): Promise<{ applied: number; skipped: string[] }> {
  const skipped: string[] = [];
  let applied = 0;
  const putBaskets: Basket[] = [];
  const removeBaskets: string[] = [];
  for (const [key, d] of Object.entries(docs)) {
    if (!isSyncKey(key) || !(await applyOne(repos, key, d, putBaskets, removeBaskets))) skipped.push(key);
    else applied++;
  }
  await baskets.applySynced(putBaskets, removeBaskets);
  return { applied, skipped };
}

async function applyOne(repos: Repos, key: string, d: DocState, putBaskets: Basket[], removeBaskets: string[]): Promise<boolean> {
  const at = { at: d.t };
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (kind === 'basket') {
    if (d.deleted) {
      removeBaskets.push(id);
      return true;
    }
    const b = BasketDoc.safeParse(d.v);
    if (!b.success) return false;
    putBaskets.push({ id, ...b.data, updatedAt: d.t });
    return true;
  }
  if (d.deleted) return false;
  if (key === 'watchlist') {
    const w = WatchlistEntries.safeParse(d.v);
    if (!w.success) return false;
    await repos.watchlist.replace(w.data, at);
    return true;
  }
  if (kind === 'layout') {
    const k = LayoutKey.safeParse({ key: id });
    const l = LayoutSchema.safeParse(d.v);
    if (!k.success || !l.success) return false;
    await repos.layouts.put(k.data.key, l.data, at);
    return true;
  }
  if (kind === 'drawings') {
    const s = SymbolIdSchema.safeParse(id);
    const ds = DrawingsBody.safeParse(d.v);
    if (!s.success || !ds.success) return false;
    await repos.drawings.put(s.data as SymbolId, ds.data, at);
    return true;
  }
  return false;
}

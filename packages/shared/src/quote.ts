import type { Quote, QuoteExt, SymbolId } from './types.js';

/** Percent move from `base` to `price`; null when either is not finite or the base is zero. */
export function pctChange(price: number, base: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(base) || base === 0) return null;
  return ((price - base) / base) * 100;
}

/**
 * A basket's extended-hours value: Σ unitsᵢ × (extᵢ.price if constituent i has one, else its regular price), with the
 * change vs the basket's REGULAR value `regularPrice` (Σ unitsᵢ × priceᵢ). The session label and ts come from the
 * latest extended print. Undefined when no constituent has an extended price, or a constituent quote is missing.
 */
export function basketQuoteExt(
  units: Record<SymbolId, number>, byId: ReadonlyMap<SymbolId, Quote>, regularPrice: number,
): QuoteExt | undefined {
  if (!(regularPrice > 0)) return undefined;
  let price = 0;
  let latest: QuoteExt | undefined;
  for (const [id, u] of Object.entries(units)) {
    const q = byId.get(id);
    if (!q) return undefined;
    price += u * (q.ext ? q.ext.price : q.price);
    if (q.ext && (!latest || q.ext.ts > latest.ts)) latest = q.ext;
  }
  const changePct = pctChange(price, regularPrice);
  if (!latest || changePct === null || !(price > 0)) return undefined;
  return { session: latest.session, price, changePct, ts: latest.ts };
}

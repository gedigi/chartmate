import { MAX_SYMBOL_ID_LENGTH, normalizeSymbolId, tryNormalizeSymbolId } from '@chartmate/shared';
import { z } from 'zod';

/** Parses `input` or throws the ZodError (mapped to 400 `invalid_request` by the app error handler). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return schema.parse(input);
}

export function isSymbolId(s: string): boolean {
  return tryNormalizeSymbolId(s) !== null;
}

/** A valid symbol id, normalized (`crypto:btc` → `crypto:BTC`; see parseSymbolId). */
export const SymbolIdSchema = z.string().max(MAX_SYMBOL_ID_LENGTH)
  .refine(isSymbolId, { message: 'invalid symbol id' })
  .transform((s) => normalizeSymbolId(s));

/** Comma-separated symbol ids (normalized, deduped, empties dropped), at most `max`. */
export function symbolList(max: number) {
  return z.string().max(10_000).default('')
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter((x) => x !== ''))])
    .pipe(z.array(SymbolIdSchema).max(max))
    .transform((ids) => [...new Set(ids)]);
}

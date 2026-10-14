import { parseSymbolId } from '@chartmate/shared';
import { z } from 'zod';

/** Parses `input` or throws the ZodError (mapped to 400 `invalid_request` by the app error handler). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return schema.parse(input);
}

export function isSymbolId(s: string): boolean {
  try {
    parseSymbolId(s);
    return true;
  } catch {
    return false;
  }
}

export const SymbolIdSchema = z.string().max(100).refine(isSymbolId, { message: 'invalid symbol id' });

/** Comma-separated symbol ids (trimmed, deduped, empties dropped), at most `max`. */
export function symbolList(max: number) {
  return z.string().max(10_000).default('')
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter((x) => x !== ''))])
    .pipe(z.array(SymbolIdSchema).max(max));
}

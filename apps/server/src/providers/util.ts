/** Number of decimals in an increment string like "0.01000000" (capped). */
export function decimalsOf(increment: string | undefined, cap = 8): number {
  if (!increment) return 2;
  const [, frac = ''] = increment.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return Math.min(cap, trimmed.length);
}

/** Exact match first, then prefix matches, then substring matches; stable within each group. */
export function rankMatches<T>(items: T[], key: (t: T) => string, q: string, limit = 20): T[] {
  const needle = q.trim().toUpperCase();
  const exact: T[] = [];
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const k = key(it).toUpperCase();
    if (needle && k === needle) exact.push(it);
    else if (k.startsWith(needle)) prefix.push(it);
    else if (k.includes(needle)) contains.push(it);
  }
  return [...exact, ...prefix, ...contains].slice(0, limit);
}

/** Strict numeric parse: numbers pass through, non-blank strings are parsed, anything else is NaN. */
export function num(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && x.trim() !== '') return Number(x);
  return Number.NaN;
}

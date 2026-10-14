/** Sub-ranges of [from, to) not covered by any of the half-open `covered` ranges (any order, may overlap). */
export function missingRanges(covered: Array<[number, number]>, from: number, to: number): Array<[number, number]> {
  if (from >= to) return [];
  const sorted = covered.filter(([a, b]) => a < b && b > from && a < to).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const [a, b] of sorted) {
    if (a > cursor) out.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) return out;
  }
  if (cursor < to) out.push([cursor, to]);
  return out;
}

/** Sorts and merges overlapping or adjacent ranges; drops empty ones. */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Splits [from, to) into consecutive chunks of at most `span` ms. */
export function splitRange(from: number, to: number, span: number | undefined): Array<[number, number]> {
  if (from >= to) return [];
  if (span === undefined || !(span > 0) || !Number.isFinite(span)) return [[from, to]];
  const out: Array<[number, number]> = [];
  for (let a = from; a < to; a += span) out.push([a, Math.min(a + span, to)]);
  return out;
}

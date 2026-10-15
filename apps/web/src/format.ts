/**
 * A percent change as shown in the UI (watchlist, baskets): two decimals, signed, rounded first so a tiny move never
 * reads "-0.00%". `dir` is the color it takes: '' (neutral) when it rounds to zero.
 */
export function fmtChange(pct: number): { text: string; dir: 'up' | 'down' | '' } {
  const r = Math.round(pct * 100) / 100;
  if (r === 0) return { text: '0.00%', dir: '' };
  return { text: `${r > 0 ? '+' : ''}${r.toFixed(2)}%`, dir: r > 0 ? 'up' : 'down' };
}

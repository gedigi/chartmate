/** Path of a request URL without its query string, percent-decoded, duplicate slashes collapsed; null if undecodable. */
export function decodedPath(url: string): string | null {
  const q = url.indexOf('?');
  const raw = q < 0 ? url : url.slice(0, q);
  try {
    return decodeURIComponent(raw).replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}

/** True for `/api` and anything under it (case-insensitive), judged on the decoded path; undecodable paths that look like API paths count too. */
export function isApiPath(url: string): boolean {
  const path = decodedPath(url);
  if (path === null) return looksLikeApi(url);
  const p = path.toLowerCase();
  return p === '/api' || p.startsWith('/api/');
}

/** Conservative check for raw (undecodable) URLs: `/api…` or an encoded first segment. */
export function looksLikeApi(url: string): boolean {
  const p = url.toLowerCase().replace(/^\/+/, '/');
  return p.startsWith('/api') || p.startsWith('/%');
}

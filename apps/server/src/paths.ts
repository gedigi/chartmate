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

/**
 * True when the first path segment is `api` (case-insensitive), judged on the decoded path with backslashes treated
 * as slashes (as browsers do) and matrix parameters (`;…`) stripped from the segment: `/api`, `/api/x`, `/api;x/y`,
 * `/\api/y` all count. Undecodable paths that look like API paths count too.
 */
export function isApiPath(url: string): boolean {
  const path = decodedPath(url);
  if (path === null) return looksLikeApi(url);
  return firstSegment(path) === 'api';
}

function firstSegment(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const seg = p.split('/', 1)[0] ?? '';
  return seg.split(';', 1)[0]!.toLowerCase();
}

/** Conservative check for raw (undecodable) URLs: `/api…` (after slashes/backslashes) or an encoded first segment. */
export function looksLikeApi(url: string): boolean {
  const p = url.toLowerCase().replace(/^[\/\\]+/, '/');
  return p.startsWith('/api') || p.startsWith('/%');
}

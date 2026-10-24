import { useSyncExternalStore } from 'react';

/**
 * Phone width: the compact layout (bottom tab bar, the watchlist as its own view, drawing tools in a strip under the
 * chart). styles.css uses the same width in its compact @media rules; keep both equal.
 */
export const COMPACT_QUERY = '(max-width: 640px)';

const media = (): MediaQueryList | null =>
  (typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null);

function subscribe(onChange: () => void): () => void {
  const m = media();
  m?.addEventListener('change', onChange);
  return () => m?.removeEventListener('change', onChange);
}

/** Whether the window is phone-width (COMPACT_QUERY), kept current as it resizes or rotates. */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}

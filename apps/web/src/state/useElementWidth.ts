import { useEffect, useState } from 'react';

const identity = (w: number) => w;

/**
 * The content width of an element, tracked with a ResizeObserver and passed through `map` (null until first measured,
 * or without ResizeObserver). The component re-renders only when the mapped value changes, so a coarse `map` keeps a
 * live resize cheap. `map` must be stable (module-level). Pass the returned callback as the element's `ref`.
 */
export function useElementWidth<T = number>(
  map: (width: number) => T = identity as (width: number) => T,
): [(el: HTMLElement | null) => void, T | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) setValue(map(Math.round(rect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, map]);
  return [setEl, value];
}

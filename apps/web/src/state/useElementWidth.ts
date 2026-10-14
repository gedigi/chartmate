import { useEffect, useState } from 'react';

/**
 * The content width of an element, tracked with a ResizeObserver (null until first measured, or without
 * ResizeObserver). Pass the returned callback as the element's `ref`.
 */
export function useElementWidth(): [(el: HTMLElement | null) => void, number | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) setWidth(Math.round(rect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

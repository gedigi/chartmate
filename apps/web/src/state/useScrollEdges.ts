import { useEffect, useState } from 'react';

/** Whether a horizontally scrolling element hides content past its start (left) / end (right) edge. */
export interface ScrollEdges { start: boolean; end: boolean }

const NONE: ScrollEdges = { start: false, end: false };
/** Sub-pixel slack: a row scrolled to its end can stop a fraction of a pixel short. */
const SLACK_PX = 1;

/**
 * Tracks which edges of a sideways-scrolling element hide content (on scroll and resize), e.g. to fade them. Pass the
 * returned callback as the element's `ref`.
 */
export function useScrollEdges(): [(el: HTMLElement | null) => void, ScrollEdges] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NONE);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > SLACK_PX;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - SLACK_PX;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    for (const child of el.children) ro?.observe(child); // content growing (e.g. the range span) changes the overflow too
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [el]);
  return [setEl, edges];
}

/** The `data-fade` value for `edges`: 'none', 'start', 'end' or 'both'. */
export function scrollFade(edges: ScrollEdges): 'none' | 'start' | 'end' | 'both' {
  if (edges.start && edges.end) return 'both';
  return edges.start ? 'start' : edges.end ? 'end' : 'none';
}

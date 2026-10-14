// Width of the right sidebar (watchlist + symbol details): a per-device UI preference in `chartmate.sidebar.width`.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { readStored, writeStored } from './storage';

const KEY = 'sidebar.width';
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 240;
/** The chart never gets narrower than this while the sidebar is open. */
export const MIN_CHART_WIDTH = 480;
/** Horizontal shell chrome next to the two panels: the chart's left gutter and the sidebar's two (3 × 8 px). */
const SHELL_CHROME = 24;

export interface SidebarBounds { min: number; max: number }

/** At most half the window, and never so wide that the chart drops below MIN_CHART_WIDTH. */
export function sidebarWidthBounds(viewportWidth: number): SidebarBounds {
  const max = Math.floor(Math.min(viewportWidth / 2, viewportWidth - MIN_CHART_WIDTH - SHELL_CHROME));
  return { min: MIN_SIDEBAR_WIDTH, max: Math.max(MIN_SIDEBAR_WIDTH, max) };
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  const { min, max } = sidebarWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, Math.round(width)));
}

function readPreferred(): number {
  const raw = readStored(KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SIDEBAR_WIDTH;
}

export interface SidebarWidth extends SidebarBounds {
  /** The width to render: the preference clamped to the current window. */
  width: number;
  /** The element carrying `--sidebar-w` (the app shell): previews write to it directly. */
  shellRef: MutableRefObject<HTMLElement | null>;
  /**
   * Shows a width live (while dragging) by writing `--sidebar-w` on the shell element: no React state, nothing stored,
   * so a drag re-renders nothing. Returns the clamped width shown.
   */
  preview: (width: number) => number;
  /** Sets and stores a width; returns the clamped width. */
  commit: (width: number) => number;
  /** Back to the default width. */
  reset: () => void;
}

/**
 * The stored preference is kept as chosen and clamped on every render, so shrinking the window narrows the sidebar
 * and growing it again restores the chosen width.
 */
export function useSidebarWidth(): SidebarWidth {
  const [preferred, setPreferred] = useState(readPreferred);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const shellRef = useRef<HTMLElement | null>(null);
  const show = (w: number) => shellRef.current?.style.setProperty('--sidebar-w', `${w}px`);

  const preview = useCallback((w: number) => {
    const next = clampSidebarWidth(w, window.innerWidth);
    show(next);
    return next;
  }, []);
  const commit = useCallback((w: number) => {
    const next = clampSidebarWidth(w, window.innerWidth);
    show(next); // also when React sees no change (a drag that ends where it started) and so would not re-apply it
    setPreferred(next);
    writeStored(KEY, String(next));
    return next;
  }, []);
  const reset = useCallback(() => { commit(DEFAULT_SIDEBAR_WIDTH); }, [commit]);

  return { width: clampSidebarWidth(preferred, viewport), ...sidebarWidthBounds(viewport), shellRef, preview, commit, reset };
}

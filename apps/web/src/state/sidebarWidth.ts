// Width of the right sidebar (watchlist + symbol details): a per-device UI preference in `chartmate.sidebar.width`.
import { useCallback, useEffect, useState } from 'react';
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
  /** Shows a width live (while dragging) without storing it. */
  preview: (width: number) => void;
  /** Sets and stores a width. */
  commit: (width: number) => void;
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

  const preview = useCallback((w: number) => setPreferred(clampSidebarWidth(w, window.innerWidth)), []);
  const commit = useCallback((w: number) => {
    const next = clampSidebarWidth(w, window.innerWidth);
    setPreferred(next);
    writeStored(KEY, String(next));
  }, []);
  const reset = useCallback(() => {
    setPreferred(DEFAULT_SIDEBAR_WIDTH);
    writeStored(KEY, String(DEFAULT_SIDEBAR_WIDTH));
  }, []);

  return { width: clampSidebarWidth(preferred, viewport), ...sidebarWidthBounds(viewport), preview, commit, reset };
}

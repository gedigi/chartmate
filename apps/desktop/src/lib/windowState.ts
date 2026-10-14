import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState {
  bounds: Rect | null;
  maximized: boolean;
  /** Last UI theme, so the window background matches the first paint (no white/black flash). */
  theme: 'dark' | 'light';
}

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 800, height: 500 };
export const BACKGROUND: Readonly<Record<WindowState['theme'], string>> = { dark: '#07090f', light: '#e7eaf1' };

const DEFAULT_STATE: WindowState = { bounds: null, maximized: false, theme: 'dark' };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses persisted state defensively: anything malformed falls back to defaults field by field. */
export function parseWindowState(raw: unknown): WindowState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
  const o = raw as Record<string, unknown>;
  const b = o.bounds as Record<string, unknown> | undefined;
  const bounds = b && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height)
    && b.width >= MIN_SIZE.width && b.height >= MIN_SIZE.height && b.width <= 16384 && b.height <= 16384
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
    : null;
  return {
    bounds,
    maximized: o.maximized === true,
    theme: o.theme === 'light' ? 'light' : 'dark',
  };
}

/** Keeps saved bounds only if their top-left area is visible on one of the current displays' work areas. */
export function visibleBounds(bounds: Rect | null, workAreas: readonly Rect[]): Rect | null {
  if (!bounds) return null;
  const grab = 100; // enough of the title bar to drag the window back
  const ok = workAreas.some((a) =>
    bounds.x + grab <= a.x + a.width && bounds.x + bounds.width - grab >= a.x
    && bounds.y >= a.y && bounds.y + grab <= a.y + a.height);
  return ok ? bounds : null;
}

export function loadWindowState(file: string): WindowState {
  try {
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Atomic write (temp file + rename), owner-only. Errors are swallowed: state is a convenience. */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

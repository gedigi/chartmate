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

const overlap = (b: Rect, a: Rect): number =>
  Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x))
  * Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y));

/**
 * Restores saved bounds onto the current displays, or returns null (default size) when the window's title bar
 * area is on none of them. The work area chosen is the one the window overlaps most; the size is clamped to it
 * (a window saved on a larger, now missing display would otherwise open bigger than the screen), then the position,
 * so the whole window, edges and title bar included, is inside that work area.
 */
export function visibleBounds(bounds: Rect | null, workAreas: readonly Rect[]): Rect | null {
  if (!bounds) return null;
  const grab = 100; // enough of the title bar to drag the window back
  const titleBarVisible = (a: Rect) =>
    bounds.x + grab <= a.x + a.width && bounds.x + bounds.width - grab >= a.x
    && bounds.y + grab > a.y && bounds.y < a.y + a.height - grab;
  let area: Rect | null = null;
  for (const a of workAreas) {
    if (titleBarVisible(a) && (area === null || overlap(bounds, a) > overlap(bounds, area))) area = a;
  }
  if (!area) return null;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/**
 * The page's theme when the window closes (`read` evaluates `data-theme` in the page), so the next launch paints
 * the right background. If the page does not answer within `timeoutMs`, fails, or reports anything else, the
 * previous theme is kept.
 */
export async function probeTheme(read: () => Promise<unknown>, previous: WindowState['theme'], timeoutMs = 300): Promise<WindowState['theme']> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<unknown>((r) => { timer = setTimeout(() => r(previous), timeoutMs); });
  try {
    const t = await Promise.race([read().catch(() => previous), timeout]);
    return t === 'light' || t === 'dark' ? t : previous;
  } finally {
    clearTimeout(timer);
  }
}

interface FocusableWindow { isDestroyed(): boolean; isMinimized(): boolean; restore(): void; focus(): void }

/**
 * A second launch of the app: focus (and restore) the window, or open one if there is none (macOS keeps running
 * with no window). Before startup has finished (`ready` false) it does nothing, since startup opens the window.
 */
export function focusOrCreateWindow(win: FocusableWindow | null, o: { ready: boolean; create: () => void }): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  if (o.ready) o.create();
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

import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron';
import type { WindowState } from './windowState.js';

type Theme = WindowState['theme'];

/**
 * Frameless ("borderless") window chrome: the web top bar is the title bar (its drag region and per-platform padding
 * live in apps/web, see src/desktopShell.ts and the `[data-shell]` rules in styles.css).
 *
 * - macOS: hidden title bar, native traffic lights moved onto the top bar and vertically centered on it; the
 *   window keeps its shadow, rounded corners, full screen and double-click-to-zoom (app-region drag).
 * - Windows: hidden title bar + the native caption buttons (minimize / maximize / close, snap layouts) drawn as
 *   an overlay over the top bar's right end, in the top bar's colors.
 * - Linux (not a release target): the native frame, unchanged.
 */

/** Height of the web top bar (--topbar-h in apps/web/src/styles.css). */
export const TOP_BAR_HEIGHT = 44;

/** Native macOS window buttons (traffic lights) are 14 px tall; this centers them on the top bar. */
export const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 14, y: (TOP_BAR_HEIGHT - 14) / 2 - 1 });

/**
 * Caption button overlay colors per theme: the top bar surface (--bg-panel) and its text (--text). The web page
 * announces its theme through <meta name="theme-color"> = that theme's --bg-panel (desktop shell only).
 */
export const TITLE_BAR_OVERLAY: Readonly<Record<Theme, Readonly<{ color: string; symbolColor: string }>>> = Object.freeze({
  dark: Object.freeze({ color: '#07090f', symbolColor: '#e9ecf4' }),
  light: Object.freeze({ color: '#e7eaf1', symbolColor: '#131726' }),
});

/** Overlay options for `theme` (Windows). The height leaves the top bar's 1 px bottom border visible. */
export function titleBarOverlay(theme: Theme): TitleBarOverlayOptions {
  return { ...TITLE_BAR_OVERLAY[theme], height: TOP_BAR_HEIGHT - 1 };
}

/** BrowserWindow options that make the window frameless on `platform` (empty on other platforms). */
export function frameOptions(platform: NodeJS.Platform, theme: Theme): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } };
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(theme) };
  return {};
}

/**
 * The theme a page's theme color stands for, or null. Strict: only the two exact --bg-panel values are accepted
 * (case-insensitive #rrggbb); anything else (other colors, alpha, named colors, null) is ignored.
 */
export function themeFromThemeColor(color: unknown): Theme | null {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  const c = color.toLowerCase();
  for (const t of ['dark', 'light'] as const) if (TITLE_BAR_OVERLAY[t].color === c) return t;
  return null;
}

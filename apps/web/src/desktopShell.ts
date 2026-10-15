import { THEME_TOKENS, type ThemeName } from './chart/theme';

/**
 * Chartmate desktop app integration (apps/desktop). The desktop window is frameless: the top bar is its title bar
 * (drag region, room for the macOS traffic lights / the Windows caption buttons; see the `[data-shell]` rules in
 * styles.css). Everything here is keyed on the desktop app's own origin, app://chartmate, so the web build served
 * over http(s) is untouched: no attribute, no meta tag, no style change.
 */
export type DesktopShell = 'mac' | 'windows';

interface LocationLike { protocol: string; host: string }
interface NavigatorLike { platform?: string; userAgentData?: { platform?: string } }

/**
 * Whether the page runs in the desktop app (its app://chartmate origin), on any platform. The desktop window opens
 * no links (no new windows, no navigation away), so external addresses are shown as text there.
 */
export function isDesktopApp(loc: LocationLike = location): boolean {
  return loc.protocol === 'app:' && loc.host === 'chartmate';
}

/**
 * The desktop shell the page runs in, or null (a browser, or a desktop platform whose window keeps the native
 * frame, i.e. Linux). The platform only distinguishes macOS from Windows inside the app:// origin.
 */
export function detectDesktopShell(loc: LocationLike, nav: NavigatorLike): DesktopShell | null {
  if (!isDesktopApp(loc)) return null;
  const p = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
  if (p.startsWith('mac')) return 'mac';
  if (p.startsWith('win')) return 'windows';
  return null;
}

/** Marks <html data-shell="mac|windows"> when running in the frameless desktop window (call before the first render). */
export function applyDesktopShell(
  root: HTMLElement = document.documentElement, loc: LocationLike = location, nav: NavigatorLike = navigator,
): DesktopShell | null {
  const shell = detectDesktopShell(loc, nav);
  if (shell) root.dataset['shell'] = shell;
  else delete root.dataset['shell'];
  return shell;
}

/**
 * Desktop shell only: <meta name="theme-color"> = the top bar color of `theme`. The desktop main process reads it
 * (Chromium's theme-color change event, no IPC) to color the Windows caption buttons like the top bar, and accepts
 * only these exact two values. Browsers never get the tag (Safari would tint its toolbar with it).
 */
export function syncShellThemeColor(theme: ThemeName, doc: Document = document): void {
  if (!doc.documentElement.dataset['shell']) return;
  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    doc.head.append(meta);
  }
  meta.setAttribute('content', THEME_TOKENS[theme].panel);
}

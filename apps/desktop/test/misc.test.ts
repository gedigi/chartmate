import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRotatingLog, scrub } from '../src/lib/logger.js';
import { menuTemplate } from '../src/lib/menu.js';
import { allowsPrereleaseUpdates, shouldEnableAutoUpdate } from '../src/lib/updatePolicy.js';
import { BACKGROUND, loadWindowState, parseWindowState, saveWindowState, visibleBounds } from '../src/lib/windowState.js';

const flatRoles = (items: unknown[]): string[] => items.flatMap((i) => {
  const o = i as { role?: string; submenu?: unknown[] };
  return [...(o.role ? [o.role] : []), ...(Array.isArray(o.submenu) ? flatRoles(o.submenu) : [])];
});

describe('menuTemplate', () => {
  it('packaged builds have no DevTools entry', () => {
    for (const isMac of [true, false]) {
      expect(flatRoles(menuTemplate({ isMac, isPackaged: true, appName: 'Chartmate' }))).not.toContain('toggleDevTools');
    }
    expect(flatRoles(menuTemplate({ isMac: true, isPackaged: false, appName: 'Chartmate' }))).toContain('toggleDevTools');
  });
  it('macOS has the standard app menu and Edit menu', () => {
    const roles = flatRoles(menuTemplate({ isMac: true, isPackaged: true, appName: 'Chartmate' }));
    expect(roles).toEqual(expect.arrayContaining(['about', 'hide', 'quit', 'editMenu', 'windowMenu']));
  });
});

describe('window background', () => {
  it('matches the web page background, --bg-panel (no flash of a different color before first paint)', () => {
    const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
    const token = (selector: string) => {
      const block = css.slice(css.indexOf(selector));
      return /--bg-panel:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(block)?.[1]?.toLowerCase();
    };
    // The page body paints the ground (--bg-panel); the chart sheet sits on it.
    expect(css).toMatch(/\bbody \{[^}]*background: var\(--bg-panel\)/);
    expect(BACKGROUND.dark).toBe(token(":root[data-theme='dark']"));
    expect(BACKGROUND.light).toBe(token(":root[data-theme='light']"));
  });
});

describe('window state', () => {
  it('parses defensively', () => {
    expect(parseWindowState(null)).toEqual({ bounds: null, maximized: false, theme: 'dark' });
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: true, theme: 'light' }))
      .toEqual({ bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: true, theme: 'light' });
    expect(parseWindowState({ bounds: { x: 'a', y: 2, width: 1000, height: 700 }, theme: 'neon' }))
      .toEqual({ bounds: null, maximized: false, theme: 'dark' });
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 10, height: 10 } }).bounds).toBeNull();
  });
  it('drops bounds that are off every display', () => {
    const screen = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    expect(visibleBounds({ x: 100, y: 100, width: 1000, height: 700 }, screen)).not.toBeNull();
    expect(visibleBounds({ x: 5000, y: 100, width: 1000, height: 700 }, screen)).toBeNull();
    expect(visibleBounds({ x: 100, y: -500, width: 1000, height: 700 }, screen)).toBeNull();
  });
  it('round-trips through a file and tolerates garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chartmate-ws-'));
    const f = join(dir, 'window-state.json');
    expect(loadWindowState(f).theme).toBe('dark');
    saveWindowState(f, { bounds: { x: 1, y: 2, width: 900, height: 600 }, maximized: false, theme: 'light' });
    expect(loadWindowState(f)).toEqual({ bounds: { x: 1, y: 2, width: 900, height: 600 }, maximized: false, theme: 'light' });
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, '{nope');
    expect(loadWindowState(f).bounds).toBeNull();
  });
});

describe('rotating log', () => {
  it('rotates by size and keeps a bounded number of files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chartmate-log-'));
    const log = createRotatingLog({ dir, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 50; i++) log.info(`line ${i} ${'x'.repeat(20)}`);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['main.log', 'main.log.1', 'main.log.2']);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThan(400);
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('line 49');
  });
  it('scrubs credentials and secrets', () => {
    expect(scrub('GET https://user:pw@host/x')).toBe('GET https://***@host/x');
    expect(scrub('password=hunter2 token: abc "apiKey":"k1" cookie=a1')).toBe('password=*** token: *** "apiKey":"***" cookie=***');
    expect(scrub('crumb=xyz&x=1')).toBe('crumb=***&x=1');
  });
  it('never throws when the directory is unusable', () => {
    const log = createRotatingLog({ dir: '/dev/null/nope' });
    expect(() => log.error('x', new Error('y'))).not.toThrow();
  });
});

describe('allowsPrereleaseUpdates', () => {
  it('only a pre-release build (a suffixed version) is offered pre-releases', () => {
    expect(allowsPrereleaseUpdates('1.0.0')).toBe(false);
    expect(allowsPrereleaseUpdates('0.1.2')).toBe(false);
    expect(allowsPrereleaseUpdates('1.1.0-beta.1')).toBe(true);
  });
});

describe('shouldEnableAutoUpdate', () => {
  const yml = 'owner: o\nrepo: r\nprovider: github\nupdaterCacheDirName: chartmate-updater\n';
  const winYml = `${yml}publisherName:\n  - CN=Chartmate\n`;
  const base = { isPackaged: true, productAutoUpdate: true, isSigned: true, platform: 'darwin' as NodeJS.Platform, updateConfig: yml, env: {} };
  it('requires every gate', () => {
    expect(shouldEnableAutoUpdate(base)).toBe(true);
    expect(shouldEnableAutoUpdate({ ...base, isPackaged: false })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, productAutoUpdate: false })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, updateConfig: null })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, isSigned: false })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, env: { CHARTMATE_DISABLE_UPDATES: '1' } })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, env: { CHARTMATE_DISABLE_UPDATES: '0' } })).toBe(true);
    expect(shouldEnableAutoUpdate({ ...base, platform: 'linux' })).toBe(false);
  });
  it('Windows: refuses to update unless app-update.yml pins publisherName', () => {
    expect(shouldEnableAutoUpdate({ ...base, platform: 'win32' })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, platform: 'win32', updateConfig: winYml })).toBe(true);
    expect(shouldEnableAutoUpdate({ ...base, platform: 'win32', updateConfig: `${yml}publisherName: CN=Chartmate\n` })).toBe(true);
    expect(shouldEnableAutoUpdate({ ...base, platform: 'win32', updateConfig: `${yml}publisherName: []\n` })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...base, platform: 'win32', updateConfig: `${yml}publisherName:\n` })).toBe(false);
  });
});

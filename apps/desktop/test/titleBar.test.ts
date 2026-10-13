import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  frameOptions, themeFromThemeColor, TITLE_BAR_OVERLAY, titleBarOverlay, TOP_BAR_HEIGHT, TRAFFIC_LIGHT_POSITION,
} from '../src/lib/titleBar.js';

const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
/** `--name: #hex` inside the theme block starting at `selector`. */
const token = (selector: string, name: string) => {
  const block = css.slice(css.indexOf(selector));
  return new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)?.[1]?.toLowerCase();
};

describe('frameless window options per platform', () => {
  it('macOS: hidden title bar with the traffic lights centered on the top bar (shadow, corners, full screen kept)', () => {
    for (const theme of ['dark', 'light'] as const) {
      const o = frameOptions('darwin', theme);
      expect(o).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } });
      // Never a fully frameless/transparent window: that would drop the shadow, rounded corners and resizing.
      expect(o).not.toHaveProperty('frame');
      expect(o).not.toHaveProperty('transparent');
      expect(o).not.toHaveProperty('titleBarOverlay');
    }
    // 14 px buttons: their center within a pixel of the top bar's (above its 1 px bottom border).
    expect(Math.abs(TRAFFIC_LIGHT_POSITION.y + 7 - (TOP_BAR_HEIGHT - 1) / 2)).toBeLessThanOrEqual(1);
  });

  it('Windows: hidden title bar + caption button overlay in the top bar colors of the theme', () => {
    expect(frameOptions('win32', 'dark')).toEqual({
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#141820', symbolColor: '#e4e7ee', height: TOP_BAR_HEIGHT - 1 },
    });
    expect(frameOptions('win32', 'light')).toEqual({
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f8fa', symbolColor: '#111827', height: TOP_BAR_HEIGHT - 1 },
    });
    expect(frameOptions('win32', 'dark')).not.toHaveProperty('frame');
  });

  it('Linux keeps the native frame', () => {
    expect(frameOptions('linux', 'dark')).toEqual({});
  });

  it('titleBarOverlay returns fresh objects (setTitleBarOverlay cannot mutate the constants)', () => {
    expect(titleBarOverlay('dark')).not.toBe(titleBarOverlay('dark'));
    expect(Object.isFrozen(TITLE_BAR_OVERLAY.dark)).toBe(true);
  });
});

describe('title bar tokens match the web top bar (styles.css)', () => {
  it('overlay color = --bg-panel, symbol color = --text, height = --topbar-h', () => {
    for (const [theme, sel] of [['dark', ":root[data-theme='dark']"], ['light', ":root[data-theme='light']"]] as const) {
      expect(TITLE_BAR_OVERLAY[theme].color).toBe(token(sel, '--bg-panel'));
      expect(TITLE_BAR_OVERLAY[theme].symbolColor).toBe(token(sel, '--text'));
    }
    expect(css).toMatch(new RegExp(`--topbar-h:\\s*${TOP_BAR_HEIGHT}px;`));
  });

  it('the macOS top bar leaves room for the traffic lights (3 × 14 px buttons, 6 px apart)', () => {
    const pad = Number(/:root\[data-shell='mac'\] \.top-bar \{ padding-left: (\d+)px; \}/.exec(css)?.[1]);
    expect(pad).toBeGreaterThanOrEqual(TRAFFIC_LIGHT_POSITION.x + 3 * 14 + 2 * 6 + 8);
  });
});

describe('main process wiring (source)', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  it('the window uses the frameless options; the overlay follows only validated theme colors of the app page', () => {
    expect(main).toContain('...frameOptions(process.platform, state.theme)');
    expect(main).toMatch(/'did-change-theme-color'[\s\S]{0,200}isAppUrl\(win\.webContents\.getURL\(\)\)[\s\S]{0,120}themeFromThemeColor\(color\)/);
    // No new IPC surface: still no preload, no ipcMain.
    expect(main).not.toMatch(/\bipcMain\b|\bpreload: /);
  });
});

describe('theme-color → caption overlay theme (strict)', () => {
  it('accepts only the two exact top bar colors', () => {
    expect(themeFromThemeColor('#141820')).toBe('dark');
    expect(themeFromThemeColor('#F7F8FA')).toBe('light');
    for (const bad of [null, undefined, '', 'red', '#141821', '#14182000', '#fff', 'rgb(20,24,32)', ' #141820', 42, {}]) {
      expect(themeFromThemeColor(bad)).toBeNull();
    }
  });
});

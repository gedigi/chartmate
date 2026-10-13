import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_TOKENS } from '../src/chart/theme';
import { applyDesktopShell, detectDesktopShell, syncShellThemeColor } from '../src/desktopShell';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const APP = { protocol: 'app:', host: 'chartmate' };
const MAC = { platform: 'MacIntel' };
const WIN = { platform: 'Win32' };

afterEach(() => {
  delete document.documentElement.dataset['shell'];
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  document.head.querySelectorAll('style[data-test]').forEach((m) => m.remove());
  document.body.replaceChildren();
});

describe('desktop shell detection', () => {
  it('only on the desktop app origin, app://chartmate', () => {
    expect(detectDesktopShell(APP, MAC)).toBe('mac');
    expect(detectDesktopShell(APP, WIN)).toBe('windows');
    expect(detectDesktopShell(APP, { userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe('windows');
    // Linux keeps the native frame.
    expect(detectDesktopShell(APP, { platform: 'Linux x86_64' })).toBeNull();
    // Browsers (whatever the platform), and other app:// hosts.
    for (const loc of [{ protocol: 'http:', host: 'localhost:5173' }, { protocol: 'https:', host: 'chartmate.example' }, { protocol: 'app:', host: 'other' }]) {
      expect(detectDesktopShell(loc, MAC)).toBeNull();
      expect(detectDesktopShell(loc, WIN)).toBeNull();
    }
  });

  it('jsdom (http://localhost) = the web build: no attribute, no theme-color meta', () => {
    expect(applyDesktopShell()).toBeNull();
    expect(document.documentElement.dataset['shell']).toBeUndefined();
    syncShellThemeColor('dark');
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
  });

  it('marks <html data-shell> and keeps <meta name="theme-color"> at the top bar color of the theme', () => {
    expect(applyDesktopShell(document.documentElement, APP, MAC)).toBe('mac');
    expect(document.documentElement.dataset['shell']).toBe('mac');
    syncShellThemeColor('dark');
    syncShellThemeColor('light');
    const metas = document.head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]).toHaveAttribute('content', THEME_TOKENS.light.panel);
    syncShellThemeColor('dark');
    expect(metas[0]).toHaveAttribute('content', THEME_TOKENS.dark.panel);
    expect(applyDesktopShell(document.documentElement, { protocol: 'http:', host: 'x' }, MAC)).toBeNull();
    expect(document.documentElement.dataset['shell']).toBeUndefined();
  });
});

describe('desktop shell styles (styles.css)', () => {
  /** jsdom computes cascaded styles from <style> elements: load the real stylesheet. */
  const mount = () => {
    const style = document.createElement('style');
    style.dataset['test'] = '';
    style.textContent = css;
    document.head.append(style);
    document.body.innerHTML = `
      <header class="top-bar"><span class="brand">Chartmate</span>
        <nav class="tabs"><button>Chart</button></nav>
        <div class="symbol-search"><input></div><div class="symbol-label"><strong>BTC</strong></div>
        <div class="top-bar-end"><button class="icon-button">x</button></div></header>
      <div class="modal-backdrop"><div class="modal"><button>Done</button></div></div>
      <div class="search-dropdown"></div>`;
    const q = (s: string) => document.querySelector(s)!;
    // jsdom's CSS parser drops -webkit-app-region: match the raw rules of styles.css instead (last match wins).
    const rules = Array.from(css.matchAll(/([^{}]+)\{\s*-webkit-app-region:\s*([a-z-]+);\s*\}/g))
      .map((m) => ({ selector: m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(), value: m[2]! }));
    const region = (el: Element) => {
      let out = '';
      for (const r of rules) if (el.matches(r.selector)) out = r.value;
      return out;
    };
    return { q, region, pad: (side: 'Left' | 'Right') => getComputedStyle(q('.top-bar'))[`padding${side}`] };
  };

  it('the web build: no drag region and the usual top bar padding', () => {
    const { q, region, pad } = mount();
    expect(region(q('.top-bar'))).toBe('');
    expect(region(q('.tabs button'))).toBe('');
    expect(region(q('.top-bar'))).toBe('');
    expect(pad('Left')).toBe('10px');
    expect(pad('Right')).toBe('10px');
  });

  it('desktop: the top bar drags the window, its controls and overlapping popups do not', () => {
    document.documentElement.dataset['shell'] = 'mac';
    const { q, region } = mount();
    expect(region(q('.top-bar'))).toBe('drag');
    expect(region(q('.symbol-label'))).toBe(''); // plain text: part of the drag area
    for (const s of ['.tabs', '.tabs button', '.symbol-search', '.symbol-search input', '.top-bar-end', '.icon-button', '.modal-backdrop', '.modal', '.search-dropdown']) {
      expect(region(q(s)), s).toBe('no-drag');
    }
  });

  it('macOS: room for the traffic lights on the left (not in full screen); Windows: room for the caption buttons on the right', () => {
    document.documentElement.dataset['shell'] = 'mac';
    const { pad } = mount();
    expect(pad('Left')).toBe('80px');
    document.documentElement.toggleAttribute('data-fullscreen', true);
    expect(pad('Left')).toBe('10px');
    document.documentElement.removeAttribute('data-fullscreen');
    document.documentElement.dataset['shell'] = 'windows';
    expect(pad('Left')).toBe('10px');
    expect(css).toMatch(/:root\[data-shell='windows'\] \.top-bar \{\s*padding-right: calc\(10px \+ 100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, calc\(100vw - 138px\)\)\);/);
  });
});

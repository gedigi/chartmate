import { EventEmitter } from 'node:events';
import type { App, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_ORIGIN, hardenApp, hardenSession, hardenWebContents, isAppUrl, isRendererRequestAllowed, PRIVILEGED_SCHEMES,
  secureWebPreferences,
} from '../src/lib/hardening.js';

describe('webPreferences (security configuration snapshot)', () => {
  it('packaged: sandboxed, isolated, no Node, no webviews, no DevTools', () => {
    expect(secureWebPreferences({ isPackaged: true })).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      autoplayPolicy: 'user-gesture-required',
      backgroundThrottling: true,
      devTools: false,
    });
  });

  it('has no preload script', () => {
    expect(secureWebPreferences({ isPackaged: true })).not.toHaveProperty('preload');
    expect(secureWebPreferences({ isPackaged: false })).not.toHaveProperty('preload');
  });

  it('development keeps every protection and only enables DevTools', () => {
    const dev = secureWebPreferences({ isPackaged: false });
    const prod = secureWebPreferences({ isPackaged: true });
    expect({ ...dev, devTools: false }).toEqual(prod);
    expect(dev.devTools).toBe(true);
  });
});

describe('app:// scheme privileges', () => {
  it('is standard + secure + fetch + stream, CORS off, never bypasses CSP, no service workers', () => {
    expect(PRIVILEGED_SCHEMES).toEqual([{
      scheme: 'app',
      privileges: {
        standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true,
        bypassCSP: false, allowServiceWorkers: false,
      },
    }]);
  });
});

describe('URL rules', () => {
  it('isAppUrl accepts only app://altv', () => {
    expect(isAppUrl(`${APP_ORIGIN}/`)).toBe(true);
    expect(isAppUrl(`${APP_ORIGIN}/assets/x.js?y#z`)).toBe(true);
    for (const u of ['app://evil/', 'https://altv/', 'https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', '']) {
      expect(isAppUrl(u), u).toBe(false);
    }
  });

  it('renderer requests: app://altv only; devtools: only in development', () => {
    expect(isRendererRequestAllowed('app://altv/api/health', { dev: false })).toBe(true);
    for (const u of ['https://example.com/', 'http://127.0.0.1:8787/api', 'ws://x/', 'file:///etc/passwd', 'app://other/', 'devtools://devtools/bundled/x.html', 'chrome-extension://x/y', 'blob:app://altv/1']) {
      expect(isRendererRequestAllowed(u, { dev: false }), u).toBe(false);
    }
    expect(isRendererRequestAllowed('devtools://devtools/bundled/x.html', { dev: true })).toBe(true);
    expect(isRendererRequestAllowed('https://example.com/', { dev: true })).toBe(false);
  });
});

class FakeContents extends EventEmitter {
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  closeDevTools = vi.fn();
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }) { this.openHandler = fn; }
}

const ev = () => ({ preventDefault: vi.fn() });

describe('hardenWebContents', () => {
  const setup = (isPackaged = true) => {
    const c = new FakeContents();
    const onBlocked = vi.fn();
    hardenWebContents(c as unknown as WebContents, { isPackaged, onBlocked });
    return { c, onBlocked };
  };

  it('blocks navigation and redirects away from app://altv, allows same-origin', () => {
    const { c, onBlocked } = setup();
    for (const name of ['will-navigate', 'will-redirect']) {
      const bad = ev();
      c.emit(name, bad, 'https://example.com/');
      expect(bad.preventDefault, name).toHaveBeenCalled();
      const ok = ev();
      c.emit(name, ok, 'app://altv/#/baskets');
      expect(ok.preventDefault, name).not.toHaveBeenCalled();
    }
    expect(onBlocked).toHaveBeenCalledWith('navigation', 'https://example.com');
  });

  it('blocks frame navigations (event.url form)', () => {
    const { c } = setup();
    const bad = { ...ev(), url: 'file:///etc/passwd' };
    c.emit('will-frame-navigate', bad);
    expect(bad.preventDefault).toHaveBeenCalled();
  });

  it('denies every window.open, including same-origin', () => {
    const { c } = setup();
    expect(c.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(c.openHandler!({ url: 'app://altv/' })).toEqual({ action: 'deny' });
  });

  it('prevents webview attachment', () => {
    const { c } = setup();
    const e = ev();
    c.emit('will-attach-webview', e, {}, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('closes DevTools immediately if they ever open in a packaged build', () => {
    const { c } = setup(true);
    c.emit('devtools-opened');
    expect(c.closeDevTools).toHaveBeenCalled();
    const dev = setup(false);
    dev.c.emit('devtools-opened');
    expect(dev.c.closeDevTools).not.toHaveBeenCalled();
  });
});

describe('hardenSession', () => {
  function fakeSession() {
    const s = Object.assign(new EventEmitter(), {
      permissionRequest: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void),
      permissionCheck: null as null | ((...a: unknown[]) => boolean),
      devicePermission: null as null | ((...a: unknown[]) => boolean),
      displayMedia: null as null | ((req: unknown, cb: (r: unknown) => void) => void),
      spell: true,
      beforeRequest: null as null | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
      setPermissionRequestHandler(fn: never) { s.permissionRequest = fn; },
      setPermissionCheckHandler(fn: never) { s.permissionCheck = fn; },
      setDevicePermissionHandler(fn: never) { s.devicePermission = fn; },
      setDisplayMediaRequestHandler(fn: never) { s.displayMedia = fn; },
      setSpellCheckerEnabled(v: boolean) { s.spell = v; },
      webRequest: { onBeforeRequest(fn: never) { s.beforeRequest = fn; } },
    });
    return s;
  }

  it('denies all permissions, devices, display capture, downloads; disables spellcheck', () => {
    const s = fakeSession();
    hardenSession(s as unknown as Session, { isPackaged: true });
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal', 'fullscreen']) {
      const cb = vi.fn();
      s.permissionRequest!(null, p, cb);
      expect(cb, p).toHaveBeenCalledWith(false);
      expect(s.permissionCheck!(null, p, 'app://altv', {}), p).toBe(false);
    }
    expect(s.devicePermission!({ deviceType: 'usb' })).toBe(false);
    const dm = vi.fn();
    s.displayMedia!({}, dm);
    expect(dm).toHaveBeenCalledWith({});
    expect(s.spell).toBe(false);
    const dl = ev();
    s.emit('will-download', dl);
    expect(dl.preventDefault).toHaveBeenCalled();
    const sel = ev();
    const selCb = vi.fn();
    s.emit('select-usb-device', sel, {}, selCb);
    expect(sel.preventDefault).toHaveBeenCalled();
    expect(selCb).toHaveBeenCalledWith(null);
  });

  it('cancels every renderer request that is not app://altv', () => {
    const s = fakeSession();
    hardenSession(s as unknown as Session, { isPackaged: true });
    const decide = (url: string) => {
      let r: { cancel: boolean } | undefined;
      s.beforeRequest!({ url }, (x) => { r = x; });
      return r!.cancel;
    };
    expect(decide('app://altv/api/health')).toBe(false);
    expect(decide('https://example.com/')).toBe(true);
    expect(decide('https://query1.finance.yahoo.com/')).toBe(true);
    expect(decide('devtools://devtools/x')).toBe(true);
  });
});

describe('hardenApp', () => {
  it('hardens every WebContents created later', () => {
    const app = new EventEmitter();
    hardenApp(app as unknown as App, { isPackaged: true });
    const c = new FakeContents();
    app.emit('web-contents-created', {}, c);
    expect(c.openHandler!({ url: 'https://x' })).toEqual({ action: 'deny' });
    const e = ev();
    c.emit('will-navigate', e, 'https://example.com');
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

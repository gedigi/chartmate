import { EventEmitter } from 'node:events';
import type { App, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_ORIGIN, hardenAllSessions, hardenApp, hardenSession, hardenWebContents, isAppUrl, isRendererRequestAllowed, PRIVILEGED_SCHEMES,
  secureWebPreferences,
} from '../src/lib/hardening.js';
import { CONTENT_SECURITY_POLICY } from '../src/lib/securityHeaders.js';

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
  it('isAppUrl accepts only app://chartmate', () => {
    expect(isAppUrl(`${APP_ORIGIN}/`)).toBe(true);
    expect(isAppUrl(`${APP_ORIGIN}/assets/x.js?y#z`)).toBe(true);
    for (const u of ['app://evil/', 'https://chartmate/', 'https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', '']) {
      expect(isAppUrl(u), u).toBe(false);
    }
  });

  it('renderer requests: app://chartmate only; devtools: only in development', () => {
    expect(isRendererRequestAllowed('app://chartmate/api/health', { dev: false })).toBe(true);
    for (const u of ['https://example.com/', 'http://127.0.0.1:8787/api', 'ws://x/', 'file:///etc/passwd', 'app://other/', 'devtools://devtools/bundled/x.html', 'chrome-extension://x/y', 'blob:app://chartmate/1']) {
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

  it('blocks navigation and redirects away from app://chartmate, allows same-origin', () => {
    const { c, onBlocked } = setup();
    for (const name of ['will-navigate', 'will-redirect']) {
      const bad = ev();
      c.emit(name, bad, 'https://example.com/');
      expect(bad.preventDefault, name).toHaveBeenCalled();
      const ok = ev();
      c.emit(name, ok, 'app://chartmate/#/baskets');
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
    expect(c.openHandler!({ url: 'app://chartmate/' })).toEqual({ action: 'deny' });
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
      expect(s.permissionCheck!(null, p, 'app://chartmate', {}), p).toBe(false);
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

  it('cancels every renderer request that is not app://chartmate', () => {
    const s = fakeSession();
    hardenSession(s as unknown as Session, { isPackaged: true });
    const decide = (url: string) => {
      let r: { cancel: boolean } | undefined;
      s.beforeRequest!({ url }, (x) => { r = x; });
      return r!.cancel;
    };
    expect(decide('app://chartmate/api/health')).toBe(false);
    expect(decide('https://example.com/')).toBe(true);
    expect(decide('https://query1.finance.yahoo.com/')).toBe(true);
    expect(decide('devtools://devtools/x')).toBe(true);
  });
});

describe('hardenAllSessions', () => {
  const fake = () => {
    const s = Object.assign(new EventEmitter(), {
      calls: 0,
      setPermissionRequestHandler() { s.calls++; },
      setPermissionCheckHandler() {},
      setDevicePermissionHandler() {},
      setDisplayMediaRequestHandler() {},
      setSpellCheckerEnabled() {},
      webRequest: { onBeforeRequest() {} },
    });
    return s;
  };

  it('hardens the existing sessions and every session created later, once each', () => {
    const app = new EventEmitter();
    const def = fake();
    hardenAllSessions(app as unknown as App, [def as unknown as Session], { isPackaged: true });
    expect(def.calls).toBe(1);
    const partition = fake();
    app.emit('session-created', partition);
    app.emit('session-created', partition);
    app.emit('session-created', def);
    expect(partition.calls).toBe(1);
    expect(def.calls).toBe(1);
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

describe('Content Security Policy', () => {
  it('is strict: no unsafe-*, no remote sources, Trusted Types enforced', () => {
    expect(CONTENT_SECURITY_POLICY).toBe([
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
      "connect-src 'self'", "media-src 'none'", "worker-src 'none'", "frame-src 'none'", "child-src 'none'",
      "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
      "require-trusted-types-for 'script'", "trusted-types 'none'",
    ].join('; '));
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|https?:|\*/);
  });
});

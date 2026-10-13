import type { App, CustomScheme, Session, WebContents, WebPreferences } from 'electron';

export const APP_SCHEME = 'app';
export const APP_HOST = 'altv';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/`;

/**
 * The app:// scheme: `standard` (real origin, relative URLs, localStorage), `secure` (secure context like https),
 * `supportFetchAPI` (fetch('/api/…') from the renderer), `stream` (streamed request bodies), `codeCache` (V8 code
 * cache for the bundle → faster warm starts). CORS stays disabled (only same-origin requests exist), CSP is never
 * bypassed, and service workers are not allowed.
 */
export const PRIVILEGED_SCHEMES: readonly CustomScheme[] = Object.freeze([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
    bypassCSP: false,
    allowServiceWorkers: false,
  },
}]);

/**
 * BrowserWindow webPreferences. The renderer is a plain web page: OS-sandboxed, isolated, no Node, no preload
 * (it only needs fetch('/api/…') over app://), no webviews, DevTools only in unpackaged development runs.
 */
export function secureWebPreferences(opts: { isPackaged: boolean }): WebPreferences {
  return {
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
    devTools: !opts.isPackaged,
  };
}

/** True only for URLs on the app's own origin (app://altv). */
export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * Renderer request filter: only app://altv requests may leave the renderer (plus devtools:// for the DevTools UI in
 * development). Everything else (http, https, ws, file, ftp, other app hosts …) is canceled.
 */
export function isRendererRequestAllowed(url: string, opts: { dev: boolean }): boolean {
  if (isAppUrl(url)) return true;
  if (opts.dev) {
    try {
      return new URL(url).protocol === 'devtools:';
    } catch {
      return false;
    }
  }
  return false;
}

export interface HardenOptions {
  isPackaged: boolean;
  /** Notified of blocked navigations/requests (URL origin only, for the log). */
  onBlocked?: (what: string, url: string) => void;
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid>';
  }
};

type Preventable = { preventDefault(): void };

/** Navigation, window.open, webview and DevTools lockdown for one WebContents. */
export function hardenWebContents(contents: WebContents, opts: HardenOptions): void {
  const guardNav = (what: string) => (event: Preventable & { url?: string }, url?: string) => {
    const target = url ?? event.url ?? '';
    if (!isAppUrl(target)) {
      event.preventDefault();
      opts.onBlocked?.(what, originOf(target));
    }
  };
  contents.on('will-navigate', guardNav('navigation'));
  contents.on('will-frame-navigate', guardNav('frame navigation'));
  contents.on('will-redirect', guardNav('redirect'));
  contents.on('will-attach-webview', (event: Preventable) => {
    event.preventDefault();
    opts.onBlocked?.('webview', '');
  });
  contents.setWindowOpenHandler(({ url }) => {
    opts.onBlocked?.('window.open', originOf(url));
    return { action: 'deny' };
  });
  if (opts.isPackaged) {
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
}

/** Permissions, devices, downloads, spellcheck and the renderer network filter for a session. */
export function hardenSession(session: Session, opts: HardenOptions): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  session.setSpellCheckerEnabled(false);
  session.on('will-download', (event) => {
    event.preventDefault();
    opts.onBlocked?.('download', '');
  });
  for (const ev of ['select-hid-device', 'select-serial-port', 'select-usb-device'] as const) {
    session.on(ev as 'select-hid-device', (event: Preventable, _details: unknown, callback: (id?: string | null) => void) => {
      event.preventDefault();
      callback(null);
    });
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isRendererRequestAllowed(details.url, { dev: !opts.isPackaged });
    if (!allowed) opts.onBlocked?.('request', originOf(details.url));
    callback({ cancel: !allowed });
  });
}

/**
 * Applies `hardenSession` to `existing` sessions (the default one) and to every session created later
 * (`session-created`: partitions, the updater's session …), once per session. A session that needs other
 * network rules (the updater's) installs its own `onBeforeRequest` afterwards, which replaces this one; the
 * permission/device/download denials stay.
 */
export function hardenAllSessions(app: App, existing: readonly Session[], opts: HardenOptions): void {
  const done = new WeakSet<Session>();
  const apply = (s: Session) => {
    if (done.has(s)) return;
    done.add(s);
    hardenSession(s, opts);
  };
  app.on('session-created', apply);
  for (const s of existing) apply(s);
}

/** Applies `hardenWebContents` to every WebContents the app ever creates (windows, frames, devtools, …). */
export function hardenApp(app: App, opts: HardenOptions): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, opts));
}

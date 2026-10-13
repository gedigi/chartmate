import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { _electron as electron, chromium, expect, test, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { debugEndpointKind, executableOf, listeningSockets, processTree, spawnWithCdp } from './helpers.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const packaged = process.env.SMOKE_APP ? executableOf(process.env.SMOKE_APP) : null;
const providers = process.env.SMOKE_PROVIDERS ?? 'fixture';

/** Development: Playwright drives the main process too. Packaged: page-side only, over Chromium CDP. */
let app: ElectronApplication | null = null;
let cdp: { browser: Browser; child: ChildProcess } | null = null;
let page: Page;
const mainPid = () => (app ? app.process().pid! : cdp!.child.pid!);
const pageCount = () => (app ? app.windows().length : cdp!.browser.contexts().flatMap((c) => c.pages()).length);
let userData: string;
const consoleErrors: string[] = [];
let launchMs = 0;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'chartmate-smoke-'));
  const env = { ...process.env, ALTV_USER_DATA_DIR: userData, ALTV_PROVIDERS: providers } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const t = Date.now();
  if (packaged) {
    const { child, wsUrl } = await spawnWithCdp(packaged, env);
    const browser = await chromium.connectOverCDP(wsUrl);
    cdp = { browser, child };
    const ctx = browser.contexts()[0]!;
    page = ctx.pages().find((p) => p.url().startsWith('app://')) ?? await ctx.waitForEvent('page');
  } else {
    app = await electron.launch({ args: [APP_DIR], env });
    page = await app.firstWindow();
  }
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.waitForLoadState('load');
  await expect(page.getByTestId('chart-host').locator('canvas').first()).toBeVisible();
  launchMs = Date.now() - t;
});

test.afterAll(async () => {
  if (app) await app.close();
  if (cdp) {
    const { browser, child } = cdp;
    await browser.close().catch(() => {});
    const exited = new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
    child.kill('SIGTERM');
    await exited;
  }
});

test('loads the UI from app://altv with the product title', async () => {
  expect(page.url()).toBe('app://altv/');
  if (app) {
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
    expect(title).toBe('Chartmate');
  }
  console.log(`[smoke] launch → chart canvas visible: ${launchMs} ms (packaged=${!!packaged}, providers=${providers})`);
});

test('/api/health works through the app:// scheme, with CSP and security headers', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/health');
    return { status: res.status, body: await res.json(), csp: res.headers.get('content-security-policy'), nosniff: res.headers.get('x-content-type-options') };
  });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(r.csp).toContain("script-src 'self'");
  expect(r.csp).not.toContain('unsafe-inline');
  expect(r.nosniff).toBe('nosniff');
});

test('the chart renders candles (canvas has drawn content, no error toast)', async () => {
  await expect(page.getByTestId('chart-loading')).toHaveCount(0);
  await expect(page.locator('.chart-toast')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    let best = 0;
    for (const c of Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="chart-host"] canvas'))) {
      if (c.width < 50 || c.height < 50) continue;
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const colors = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) colors.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
      best = Math.max(best, colors.size);
    }
    return best;
  }), { timeout: 30_000 }).toBeGreaterThan(5);
});

test('writes work (PUT with keepalive over app://) and land in the SQLite file in userData', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/drawings/stock%3AAAPL', { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: '[]' });
    return res.status;
  });
  expect(r).toBeLessThan(300);
  const db = join(userData, 'altv.db');
  expect(statSync(db).isFile()).toBe(true);
  if (process.platform !== 'win32') {
    expect(statSync(userData).mode & 0o777).toBe(0o700);
    expect(statSync(db).mode & 0o777).toBe(0o600);
  }
});

test('oversized API bodies are rejected (1 MB limit)', async () => {
  const status = await page.evaluate(async () => (await fetch('/api/layouts/default', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(1024 * 1024 + 10) }),
  })).status);
  expect(status).toBe(413);
});

test('no Node in the renderer; renderer cannot reach the network', async () => {
  const r = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    let net = 'allowed';
    try {
      await fetch('https://example.com/');
    } catch {
      net = 'blocked';
    }
    let img = 'allowed';
    await new Promise<void>((resolve) => {
      const i = new Image();
      i.onload = () => resolve();
      i.onerror = () => { img = 'blocked'; resolve(); };
      i.src = 'https://example.com/favicon.ico';
    });
    return { require: typeof w.require, process: typeof w.process, module: typeof w.module, net, img, isSecure: window.isSecureContext };
  });
  expect(r).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', net: 'blocked', img: 'blocked', isSecure: true });
});

test('navigation away from app:// is blocked', async () => {
  await page.evaluate(() => { window.location.href = 'https://example.com/'; });
  await page.waitForTimeout(1000);
  expect(page.url()).toBe('app://altv/');
  await page.evaluate(() => { window.location.href = 'file:///etc/passwd'; });
  await page.waitForTimeout(500);
  expect(page.url()).toBe('app://altv/');
});

test('window.open is denied', async () => {
  const opened = await page.evaluate(() => window.open('https://example.com/') === null && window.open('app://altv/') === null);
  expect(opened).toBe(true);
  await page.waitForTimeout(500);
  expect(pageCount()).toBe(1);
});

test('path traversal over app:// returns 404', async () => {
  const statuses = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const p of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%5c..%5cpackage.json', '/..%2fmain.cjs']) {
      out[p] = (await fetch(p)).status;
    }
    return out;
  });
  for (const [p, s] of Object.entries(statuses)) expect(s, p).toBe(404);
});

test('no CSP violations and no console errors', async () => {
  const violations = await page.evaluate(() => new Promise<string[]>((resolve) => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    setTimeout(() => resolve(seen), 1000);
  }));
  expect(violations).toEqual([]);
  // The only expected CSP reports are the deliberate example.com probes of the network test above.
  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e) && !e.includes('https://example.com/'))).toEqual([]);
});

test('DevTools cannot be opened in a packaged build', async () => {
  test.skip(!packaged, 'DevTools are intentionally available in unpackaged development runs');
  // Every usual shortcut; a DevTools window would appear as a devtools:// target on the CDP connection.
  for (const k of ['Meta+Alt+I', 'Control+Shift+I', 'F12', 'Meta+Alt+J', 'Control+Shift+J']) await page.keyboard.press(k);
  await page.waitForTimeout(1000);
  const session = await cdp!.browser.newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets');
  const urls = targetInfos.map((t) => t.url);
  console.log(`[smoke] CDP targets after DevTools shortcuts: ${JSON.stringify(urls)}`);
  expect(urls.filter((u) => u.startsWith('devtools://'))).toEqual([]);
  // A renderer-initiated load of the DevTools UI is cancelled too (only app:// requests pass).
  const status = await page.evaluate(async () => {
    try {
      await fetch('devtools://devtools/bundled/inspector.html');
      return 'loaded';
    } catch {
      return 'blocked';
    }
  });
  expect(status).toBe('blocked');
});

test('no network listener: only the debug endpoint(s) the test harness itself requested', async () => {
  test.skip(process.platform === 'win32', 'lsof check is macOS/Linux only');
  const pids = processTree(mainPid());
  const listeners = listeningSockets(pids);
  const kinds = await Promise.all(listeners.map(async (l) => ({ ...l, kind: await debugEndpointKind(l.port) })));
  console.log(`[smoke] processes=${pids.length} listeners=${JSON.stringify(kinds)}`);
  // Dev: Playwright passes --inspect=0 + --remote-debugging-port=0. Packaged: --remote-debugging-port=0 only (the
  // inspector is fused off). Any other listener would be the app's own.
  const allowed = packaged ? ['cdp'] : ['cdp', 'node-inspector'];
  for (const l of kinds) expect(allowed, `${l.name} (pid ${l.pid})`).toContain(l.kind);
  expect(kinds.length).toBeLessThanOrEqual(allowed.length);
});

test('main log is written to userData/logs without secrets', async () => {
  const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).toMatch(/startup: window shown \d+ ms/);
  const m = /startup: window shown (\d+) ms/.exec(log);
  console.log(`[smoke] main-process startup → window shown: ${m?.[1]} ms`);
  expect(log).not.toMatch(/password|secret=|cookie=/i);
});

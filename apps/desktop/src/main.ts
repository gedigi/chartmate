// Electron main process: the Chartmate server (Fastify, in-process, no listener; see listenGuard.ts for the single
// macOS update-install exception) + one hardened window that talks
// to it only through the privileged app:// scheme. Bundled by scripts/bundle.mjs into dist/main.cjs.
import './boot.js'; // MUST stay first: command-line switch guard + environment sanitizing
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, protocol, screen, session } from 'electron';
import product from '../product.json' with { type: 'json' };
import { BasketService } from '../../server/src/baskets/service.js';
import { buildApp } from '../../server/src/app.js';
import { migrate } from '../../server/src/db/migrations.js';
import { createRepos } from '../../server/src/db/repos.js';
import { MarketDataService } from '../../server/src/market/service.js';
import { createRegistry } from '../../server/src/providers/registry.js';
import { DB_FILE_NAME, desktopConfig, resolveUserDataDir } from './lib/desktopConfig.js';
import {
  APP_ENTRY_URL, APP_HOST, APP_SCHEME, hardenAllSessions, hardenApp, PRIVILEGED_SCHEMES, secureWebPreferences,
} from './lib/hardening.js';
import { createCrashPolicy } from './lib/crashLimiter.js';
import { installListenGuard } from './lib/listenGuard.js';
import { serverLoggerOptions } from './lib/serverLog.js';
import { createRotatingLog } from './lib/logger.js';
import { menuTemplate } from './lib/menu.js';
import { createDirectFetch } from './lib/directFetch.js';
import { createGuardedFetch, installFetchAllowlist, providerHosts } from './lib/netAllowlist.js';
import { createNodeSqliteDb, type NodeSqliteHandle } from './lib/nodeSqlite.js';
import { createAppProtocolHandler } from './lib/protocol.js';
import { ensurePrivateDir, migrateLegacyUserData, restrictFiles } from './lib/storage.js';
import { shouldEnableAutoUpdate } from './lib/updatePolicy.js';
import {
  BACKGROUND, DEFAULT_SIZE, loadWindowState, MIN_SIZE, saveWindowState, visibleBounds, type WindowState,
} from './lib/windowState.js';

declare const __WEB_ROOT_REL__: string;
/** True only in the TEST-ONLY inspectable copy (smoke/prepare-inspectable.mjs). */
declare const __TEST_INSPECTABLE__: boolean;
/** Build signed for THIS platform (build/signing.cjs, decided at bundle time). False → updater not even bundled. */
declare const __BUILD_SIGNED__: boolean;

const t0 = Date.now() - Math.round(process.uptime() * 1000);
const isPackaged = app.isPackaged;

// Everything the main process creates (DB, WAL/SHM, logs, state) is owner-only.
process.umask(0o077);

app.setName(product.productName);
// Packaged builds always use the per-user default (only dev runs and the TEST-ONLY copy honor CHARTMATE_USER_DATA_DIR).
const userData = resolveUserDataDir(join(app.getPath('appData'), product.productName), process.env, { allowOverride: !isPackaged || __TEST_INSPECTABLE__ });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setAppLogsPath(join(userData, 'logs'));
const log = createRotatingLog({ dir: join(userData, 'logs'), name: 'main', maxBytes: 1024 * 1024, keep: 2 });

// No listening sockets: the server is reached only via fastify.inject from the app:// handler. The single,
// audited exception is the macOS update install (loopback, ephemeral port, armed by the updater only).
const listenGuard = installListenGuard(net.Server.prototype, { audit: (m) => log.warn(`listener guard: ${m}`) });

app.enableSandbox();
protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);
const hardenOpts = { isPackaged, onBlocked: (what: string, url: string) => log.warn(`blocked ${what} ${url}`) };
hardenApp(app, hardenOpts);

const { config } = desktopConfig({ userData, env: process.env });
// Outbound network: providers only, HTTPS only, exact hosts, every redirect hop checked.
const allowed = providerHosts(config);
// Transport: direct connections (no env proxy) trusting only Node's bundled root CAs, whatever the environment says.
const directFetch = createDirectFetch();
const onBlocked = (host: string) => log.warn(`blocked outbound request to ${host}`);
installFetchAllowlist(globalThis, allowed, { base: directFetch, onBlocked });

let mainWindow: BrowserWindow | null = null;
let shutdown: (() => Promise<void>) | null = null;
const stateFile = join(userData, 'window-state.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch((err: unknown) => {
    log.error('startup failed', err);
    dialog.showErrorBox(`${product.productName} could not start`, err instanceof Error ? err.message : String(err));
    app.exit(1);
  });
}

async function start(): Promise<void> {
  log.info(`starting ${product.productName} ${app.getVersion()} (electron ${process.versions.electron}, node ${process.versions.node}, packaged=${isPackaged})`);
  ensurePrivateDir(userData);
  const legacyDirs = (product.previousProductNames as string[]).map((n) => join(app.getPath('appData'), n));
  const dbFiles = [DB_FILE_NAME, `${DB_FILE_NAME}-wal`, `${DB_FILE_NAME}-shm`];
  const migratedFrom = migrateLegacyUserData({ target: userData, legacyDirs, files: [...dbFiles, 'window-state.json'], marker: DB_FILE_NAME });
  if (migratedFrom) log.info('migrated data from a previous product name');

  // Database first (migrations run before the window loads anything).
  const dbPath = join(userData, DB_FILE_NAME);
  const handle: NodeSqliteHandle = createNodeSqliteDb(dbPath);
  await migrate(handle.db);
  restrictFiles(dbFiles.map((f) => join(userData, f)));

  const repos = createRepos(handle.db, 'sqlite');
  const guarded = createGuardedFetch(directFetch, allowed, { onBlocked });
  const registry = createRegistry({
    mode: config.providers, cryptoProvider: config.cryptoProvider, binanceBaseUrl: config.binanceBaseUrl, fetchImpl: guarded,
  });
  const market = new MarketDataService({ repos, registry });
  const baskets = new BasketService({ repos, market });
  const server = await buildApp({
    config, repos, market, baskets,
    // Warnings and errors only; no stacks, headers, query strings or absolute paths (see serverLog.ts).
    logger: serverLoggerOptions((line) => log.write(line)) as unknown as NonNullable<Parameters<typeof buildApp>[0]['logger']>,
  });
  await server.ready();
  shutdown = async () => {
    await server.close();
    await handle.close();
  };

  const webRoot = join(__dirname, __WEB_ROOT_REL__);
  protocol.handle(APP_SCHEME, createAppProtocolHandler({
    webRoot,
    host: APP_HOST,
    inject: async (r) => {
      const res = await server.inject({
        method: r.method as 'GET',
        url: r.url,
        headers: r.headers,
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
      return { statusCode: res.statusCode, headers: res.headers, rawPayload: res.rawPayload };
    },
    onError: (err, where) => log.error(`app:// handler failed for ${where}`, err),
  }));
  // Every session, present and future (partitions, the updater's), gets the permission/device/network lockdown.
  hardenAllSessions(app, [session.defaultSession], hardenOpts);

  if (!isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, 'icon.png'));
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ isMac: process.platform === 'darwin', isPackaged, appName: product.productName })));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  maybeStartUpdater();
}

function createWindow(): void {
  const state = loadWindowState(stateFile);
  const bounds = visibleBounds(state.bounds, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    title: product.productName,
    show: false,
    backgroundColor: BACKGROUND[state.theme],
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    // macOS takes the icon from the bundle (.icns); Windows/Linux windows need it explicitly.
    ...(process.platform === 'darwin' ? {} : { icon: join(__dirname, 'icon.png') }),
    webPreferences: secureWebPreferences({ isPackaged }),
  });
  mainWindow = win;
  if (state.maximized) win.maximize();
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    win.show();
    log.info(`startup: window shown ${Date.now() - t0} ms after process start`);
  });
  const crashes = createCrashPolicy({ maxReloads: 3, maxErrorPages: 1, windowMs: 60_000 });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer gone: ${details.reason}`);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    // At most 3 reloads a minute, then the static error page once; if that crashes too, stop for good.
    const action = crashes.onCrash();
    if (action === 'reload') win.reload();
    else if (action === 'error-page') void win.loadURL(`${APP_ENTRY_URL}crashed.html`);
    else {
      log.error('renderer keeps crashing: giving up');
      dialog.showErrorBox(product.productName, 'The window keeps crashing and was closed. Please restart the app.');
      win.destroy();
    }
  });

  let saved = false;
  win.on('close', (e) => {
    if (saved) return;
    e.preventDefault();
    const finish = (theme: WindowState['theme']) => {
      saved = true;
      saveWindowState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized(), theme });
      win.close();
      // preventDefault above canceled an in-flight quit (⌘Q / app.quit()): resume it.
      if (appQuitRequested) app.quit();
    };
    const timeout = new Promise<string>((r) => setTimeout(() => r('dark'), 300));
    Promise.race([win.webContents.executeJavaScript('document.documentElement.dataset.theme', false), timeout])
      .then((t) => finish(t === 'light' ? 'light' : 'dark'), () => finish(state.theme));
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(APP_ENTRY_URL);
}

function maybeStartUpdater(): void {
  // Unsigned builds: this whole function body is compiled out (and dist/updater.cjs is not even produced).
  if (!__BUILD_SIGNED__) return;
  const ymlPath = join(process.resourcesPath, 'app-update.yml');
  const updateConfig = isPackaged && existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : null;
  if (!shouldEnableAutoUpdate({
    isPackaged, productAutoUpdate: product.autoUpdate === true, isSigned: __BUILD_SIGNED__, platform: process.platform,
    updateConfig, env: process.env,
  })) return;
  // Loaded only when enabled: electron-updater is a separate bundle that costs nothing otherwise.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startAutoUpdate } = require('./updater.cjs') as typeof import('./updater.js');
  startAutoUpdate(log, listenGuard);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
let appQuitRequested = false;
app.on('before-quit', () => {
  appQuitRequested = true;
  log.info('quit requested');
});
app.on('will-quit', (e) => {
  if (quitting || !shutdown) return;
  e.preventDefault();
  quitting = true;
  shutdown()
    .then(() => log.info('shutdown complete'), (err: unknown) => log.error('shutdown failed', err))
    .finally(() => app.exit(0)); // app.quit() is ignored while a quit is in progress
});

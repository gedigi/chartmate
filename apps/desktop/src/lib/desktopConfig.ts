import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../../../server/src/config.js';
import { APP_ORIGIN } from './hardening.js';

export const DB_FILE_NAME = 'chartmate.db';
export const DEFAULT_BINANCE_BASE_URL = 'https://data-api.binance.vision';

type Env = Record<string, string | undefined>;

/** An invalid environment variable. Its message is short, names the variable, and holds no path or value. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface ConfigExitDeps {
  productName: string;
  log: (msg: string) => void;
  /** `dialog.showErrorBox` (safe before `ready`). */
  showError: (title: string, content: string) => void;
  exit: (code: number) => never;
}

/**
 * Runs `build` (configuration from the environment) at startup. On failure the app does not crash with an
 * uncaught exception: the reason is logged, a short error box names the variable (a ConfigError message; anything
 * else gets a generic line, so no stack or path is shown), and the process exits with code 1.
 */
export function configOrExit<T>(build: () => T, d: ConfigExitDeps): T {
  try {
    return build();
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : 'The configuration could not be read.';
    d.log(`invalid configuration: ${msg}`);
    d.showError(`${d.productName} cannot start`, `${msg}\n\nCorrect or unset it, then start the app again.`);
    return d.exit(1);
  }
}

const val = (env: Env, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

/**
 * The Binance API hosts a hardened build accepts in BINANCE_BASE_URL (the server's Binance provider speaks the
 * /api/v3 REST API all three serve). The value adds its host to the outbound allowlist, so a hardened build never
 * lets the environment add an arbitrary one.
 */
export const KNOWN_BINANCE_HOSTS: readonly string[] = Object.freeze(['data-api.binance.vision', 'api.binance.com', 'api.binance.us']);

/** `https://<known host>` for an exact known-host origin (optional trailing slash), else null. */
function knownBinanceOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const plain = u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname === '/';
  return plain && KNOWN_BINANCE_HOSTS.includes(u.hostname) ? u.origin : null;
}

function binanceBaseUrl(raw: string | undefined, hardened: boolean, onIgnored?: (msg: string) => void): string {
  if (raw === undefined) return DEFAULT_BINANCE_BASE_URL;
  if (hardened) {
    const known = knownBinanceOrigin(raw);
    if (known !== null) return known;
    onIgnored?.(`BINANCE_BASE_URL ignored: only ${KNOWN_BINANCE_HOSTS.map((h) => `https://${h}`).join(', ')} are accepted; using the default`);
    return DEFAULT_BINANCE_BASE_URL;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError('Invalid BINANCE_BASE_URL: not a URL');
  }
  if (u.protocol !== 'https:') throw new ConfigError('Invalid BINANCE_BASE_URL: must use https');
  if (u.username || u.password || u.port || u.search || u.hash) {
    throw new ConfigError('Invalid BINANCE_BASE_URL: no credentials, port, query or fragment allowed');
  }
  return u.href.replace(/\/+$/, '');
}

/**
 * Server configuration for the desktop app. Only provider choices may come from the environment; everything that
 * concerns the network surface or storage is fixed:
 * - no listener (the Fastify app is only reached through app:// + inject; listenGuard.ts), so host/port are
 *   inert placeholders;
 * - the server's Host / Origin guard: inject requests carry Host `localhost`, so no extra host is allowed, and
 *   state-changing API requests are accepted from the renderer's own origin (app://chartmate) only;
 * - auth disabled: there is no network surface to protect, and the renderer is the only client (a password would
 *   only add a login screen in front of a single-user local app);
 * - SQLite in the per-user data directory; the web UI is served by the protocol handler, not @fastify/static;
 * - hardened builds (`hardened`, default true; lib/buildMode.ts) take BINANCE_BASE_URL only when it names a known
 *   Binance API host (KNOWN_BINANCE_HOSTS); anything else is ignored and reported once through `onIgnored`.
 */
export function desktopConfig(opts: { userData: string; env: Env; hardened?: boolean; onIgnored?: (msg: string) => void }): { config: Config; dbPath: string } {
  if (!isAbsolute(opts.userData)) throw new Error('userData must be an absolute path');
  const { env } = opts;
  const providers = val(env, 'CHARTMATE_PROVIDERS') ?? 'live';
  if (providers !== 'live' && providers !== 'fixture') throw new ConfigError('Invalid CHARTMATE_PROVIDERS: expected live or fixture');
  const crypto = val(env, 'CRYPTO_PROVIDER') ?? 'binance';
  if (crypto !== 'binance' && crypto !== 'coinbase') throw new ConfigError('Invalid CRYPTO_PROVIDER: expected binance or coinbase');
  const dbPath = join(opts.userData, DB_FILE_NAME);
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: `sqlite:${dbPath}`,
    password: null,
    sessionSecret: randomBytes(32).toString('hex'),
    cryptoProvider: crypto,
    binanceBaseUrl: binanceBaseUrl(val(env, 'BINANCE_BASE_URL'), opts.hardened ?? true, opts.onIgnored),
    providers,
    webDist: null,
    trustProxy: false,
    allowedHosts: [],
    allowedOrigins: [APP_ORIGIN],
  };
  return { config, dbPath };
}

/**
 * `CHARTMATE_USER_DATA_DIR` (absolute) overrides Electron's per-user data directory for development runs and tests.
 * Packaged builds ignore it (`allowOverride: false`), just as they refuse Chromium's --user-data-dir.
 */
export function resolveUserDataDir(platformDefault: string, env: Env, opts: { allowOverride: boolean }): string {
  if (!opts.allowOverride) return platformDefault;
  const override = val(env, 'CHARTMATE_USER_DATA_DIR');
  if (override === undefined) return platformDefault;
  if (!isAbsolute(override)) throw new ConfigError('CHARTMATE_USER_DATA_DIR must be an absolute path');
  return override;
}

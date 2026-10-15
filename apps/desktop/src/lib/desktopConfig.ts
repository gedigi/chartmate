import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../../../server/src/config.js';
import { APP_HOST } from './hardening.js';

export const DB_FILE_NAME = 'chartmate.db';
export const DEFAULT_BINANCE_BASE_URL = 'https://data-api.binance.vision';

type Env = Record<string, string | undefined>;

const val = (env: Env, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

function binanceBaseUrl(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_BINANCE_BASE_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid BINANCE_BASE_URL: not a URL');
  }
  if (u.protocol !== 'https:') throw new Error('Invalid BINANCE_BASE_URL: must use https');
  if (u.username || u.password || u.port || u.search || u.hash) {
    throw new Error('Invalid BINANCE_BASE_URL: no credentials, port, query or fragment allowed');
  }
  return u.href.replace(/\/+$/, '');
}

/**
 * Server configuration for the desktop app. Only provider choices may come from the environment; everything that
 * concerns the network surface or storage is fixed:
 * - no listener (the Fastify app is only reached through app:// + inject; listenGuard.ts), so host/port are
 *   inert placeholders;
 * - the server's Host / Origin guard allows only the renderer's own origin (app://chartmate) besides loopback;
 * - auth disabled: there is no network surface to protect, and the renderer is the only client (a password would
 *   only add a login screen in front of a single-user local app);
 * - SQLite in the per-user data directory; the web UI is served by the protocol handler, not @fastify/static.
 */
export function desktopConfig(opts: { userData: string; env: Env }): { config: Config; dbPath: string } {
  if (!isAbsolute(opts.userData)) throw new Error('userData must be an absolute path');
  const { env } = opts;
  const providers = val(env, 'CHARTMATE_PROVIDERS') ?? 'live';
  if (providers !== 'live' && providers !== 'fixture') throw new Error('Invalid CHARTMATE_PROVIDERS: expected live or fixture');
  const crypto = val(env, 'CRYPTO_PROVIDER') ?? 'binance';
  if (crypto !== 'binance' && crypto !== 'coinbase') throw new Error('Invalid CRYPTO_PROVIDER: expected binance or coinbase');
  const dbPath = join(opts.userData, DB_FILE_NAME);
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: `sqlite:${dbPath}`,
    password: null,
    sessionSecret: randomBytes(32).toString('hex'),
    cryptoProvider: crypto,
    binanceBaseUrl: binanceBaseUrl(val(env, 'BINANCE_BASE_URL')),
    providers,
    webDist: null,
    trustProxy: false,
    allowedHosts: [APP_HOST],
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
  if (!isAbsolute(override)) throw new Error('CHARTMATE_USER_DATA_DIR must be an absolute path');
  return override;
}

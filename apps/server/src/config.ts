import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { brandEnv } from './brandEnv.js';

export interface Config {
  port: number;
  /** Listen address: 127.0.0.1 by default (local runs); the Docker image sets 0.0.0.0. */
  host: string;
  databaseUrl: string;
  password: string | null;
  sessionSecret: string;
  cryptoProvider: 'binance' | 'coinbase';
  binanceBaseUrl: string;
  providers: 'live' | 'fixture';
  webDist: string | null;
  /** Fastify `trustProxy`: false (default), true, hop count, or an IP/CIDR list. */
  trustProxy: boolean | number | string;
}

const here = fileURLToPath(new URL('.', import.meta.url));
/** apps/web/dist — from both src/ (tsx) and dist/ (built), which are siblings. */
const DEFAULT_WEB_DIST = resolve(here, '../../web/dist');

/** Default SQLite file, relative to the server's working directory. */
export const DEFAULT_DATABASE_URL = 'sqlite:./data/chartmate.db';
/** File name used before the rename to Chartmate; still used when it exists and the new one does not. */
export const LEGACY_DB_FILE_NAME = 'altv.db';
const DB_FILE_NAME = 'chartmate.db';

/** App variables read as CHARTMATE_<name>, with the legacy ALTV_<name> as a fallback (see brandEnv.ts). */
export const BRAND_VARS = ['PASSWORD', 'SESSION_SECRET', 'PROVIDERS', 'WEB_DIST', 'TRUST_PROXY'] as const;

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(65_535).default(8787)),
  HOST: z.preprocess(blankToUndefined, z.string().trim().default('127.0.0.1')),
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().default(DEFAULT_DATABASE_URL).refine(
    (u) => !u.startsWith('sqlite:') || u.slice('sqlite:'.length).trim() !== '',
    { message: 'sqlite: URL has an empty path (use e.g. sqlite:./data/chartmate.db)' },
  )),
  CHARTMATE_PASSWORD: z.preprocess(blankToUndefined, z.string().optional()),
  CHARTMATE_SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
  CRYPTO_PROVIDER: z.preprocess(blankToUndefined, z.enum(['binance', 'coinbase']).default('binance')),
  BINANCE_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://data-api.binance.vision')),
  CHARTMATE_PROVIDERS: z.preprocess(blankToUndefined, z.enum(['live', 'fixture']).default('live')),
  CHARTMATE_WEB_DIST: z.preprocess(blankToUndefined, z.string().optional()),
  CHARTMATE_TRUST_PROXY: z.preprocess(blankToUndefined, z.string().optional()),
});

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = v?.trim();
  if (s === undefined || s === '' || s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * Keeps existing installs on their data: a `sqlite:` URL naming `chartmate.db` that does not exist yet falls back
 * to `altv.db` in the same directory when that one exists (the pre-rename default name). Anything else is
 * returned unchanged.
 */
export function resolveLegacySqliteUrl(url: string, fileExists: (path: string) => boolean = existsSync): string {
  if (!url.startsWith('sqlite:')) return url;
  const path = url.slice('sqlite:'.length);
  if (basename(path) !== DB_FILE_NAME || fileExists(path)) return url;
  const legacy = join(dirname(path), LEGACY_DB_FILE_NAME);
  if (!fileExists(legacy)) return url;
  // Keep the caller's relative/absolute style (join() would turn ./data/x into data/x).
  return 'sqlite:' + path.slice(0, path.length - DB_FILE_NAME.length) + LEGACY_DB_FILE_NAME;
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  opts: { fileExists?: (path: string) => boolean } = {},
): Config {
  const input: Record<string, string | undefined> = { ...env };
  for (const name of BRAND_VARS) input[`CHARTMATE_${name}`] = brandEnv(env, name);
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid configuration: ${issue.path.join('.')}: ${issue.message}`);
  }
  const e = parsed.data;
  const password = e.CHARTMATE_PASSWORD ?? null;
  const webDistCandidate = resolve(e.CHARTMATE_WEB_DIST ?? DEFAULT_WEB_DIST);
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: resolveLegacySqliteUrl(e.DATABASE_URL, opts.fileExists),
    password,
    // The 'altv:' salt predates the rename; changing it would invalidate every existing session cookie.
    sessionSecret: e.CHARTMATE_SESSION_SECRET ?? sha256Hex('altv:' + (password ?? '')),
    cryptoProvider: e.CRYPTO_PROVIDER,
    binanceBaseUrl: e.BINANCE_BASE_URL.replace(/\/+$/, ''),
    providers: e.CHARTMATE_PROVIDERS,
    trustProxy: parseTrustProxy(e.CHARTMATE_TRUST_PROXY),
    webDist: existsSync(join(webDistCandidate, 'index.html')) ? webDistCandidate : null,
  };
}

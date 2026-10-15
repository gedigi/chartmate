import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseAllowedHosts } from './hostGuard.js';

export interface Config {
  port: number;
  /** Listen address: 127.0.0.1 by default (local runs); the Docker image sets 0.0.0.0. */
  host: string;
  databaseUrl: string;
  password: string | null;
  /** Cookie signing secret (`CHARTMATE_SESSION_SECRET`); null = generated once and kept in the database. */
  sessionSecret: string | null;
  cryptoProvider: 'binance' | 'coinbase';
  binanceBaseUrl: string;
  providers: 'live' | 'fixture';
  webDist: string | null;
  /** Fastify `trustProxy`: false (default), true, hop count, or an IP/CIDR list. */
  trustProxy: boolean | number | string;
  /**
   * Hostnames served besides localhost, 127.0.0.1 and [::1] (`CHARTMATE_ALLOWED_HOSTS`). Enforced without a
   * password, and with one when non-empty (hostGuard.ts).
   */
  allowedHosts: string[];
  /**
   * Exact origins (`scheme://host`) accepted on state-changing API requests besides the request's own. Not
   * configurable from the environment; the desktop app sets its renderer origin.
   */
  allowedOrigins: string[];
  /**
   * Address the port is published on outside a container (`CHARTMATE_PUBLISHED_BIND`, set by compose.yaml from
   * CHARTMATE_BIND); only used for the startup warning about running without a password. Unset = `host`.
   */
  publishedBind?: string | null;
}

const here = fileURLToPath(new URL('.', import.meta.url));
/** apps/web/dist — from both src/ (tsx) and dist/ (built), which are siblings. */
const DEFAULT_WEB_DIST = resolve(here, '../../web/dist');

/** Default SQLite file, relative to the server's working directory. */
export const DEFAULT_DATABASE_URL = 'sqlite:./data/chartmate.db';
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(65_535).default(8787)),
  HOST: z.preprocess(blankToUndefined, z.string().trim().default('127.0.0.1')),
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().default(DEFAULT_DATABASE_URL).refine(
    (u) => !u.startsWith('sqlite:') || u.slice('sqlite:'.length).trim() !== '',
    { message: 'sqlite: URL has an empty path (use e.g. sqlite:./data/chartmate.db)' },
  )),
  // Empty = no password; a value of only whitespace is a mistake (it would silently turn auth off), not "unset".
  CHARTMATE_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().refine((s) => s.trim() !== '', {
    message: 'is only whitespace (leave it empty for no password, or set a real one)',
  }).optional()),
  CHARTMATE_SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
  CRYPTO_PROVIDER: z.preprocess(blankToUndefined, z.enum(['binance', 'coinbase']).default('binance')),
  // https only: market data must not travel (or be tampered with) in clear text.
  BINANCE_BASE_URL: z.preprocess(blankToUndefined, z.url({ protocol: /^https$/ }).refine((v) => {
    // An empty `?` or `#` (or `@`) does not show up in the parsed URL: check the raw string too.
    if (/[?#@]/.test(v)) return false;
    const u = new URL(v);
    return u.username === '' && u.password === '' && u.search === '' && u.hash === '';
  }, { message: 'must be an https URL without credentials, query or fragment' }).default('https://data-api.binance.vision')),
  CHARTMATE_PROVIDERS: z.preprocess(blankToUndefined, z.enum(['live', 'fixture']).default('live')),
  CHARTMATE_WEB_DIST: z.preprocess(blankToUndefined, z.string().optional()),
  CHARTMATE_TRUST_PROXY: z.preprocess(blankToUndefined, z.string().optional()),
  CHARTMATE_ALLOWED_HOSTS: z.preprocess(blankToUndefined, z.string().optional()),
  CHARTMATE_PUBLISHED_BIND: z.preprocess(blankToUndefined, z.string().trim().optional()),
});

function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = v?.trim();
  if (s === undefined || s === '' || s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

/** Shortest password that does not trigger a startup warning. */
export const MIN_PASSWORD_LENGTH = 12;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const isLoopbackAddress = (a: string) => LOOPBACK_HOSTS.has(a.trim().toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(a.trim());

/** Startup warnings for a configuration that works but is weaker than it should be (logged by main). */
export function configWarnings(c: Config): string[] {
  const out: string[] = [];
  if (c.password !== null && c.password.length < MIN_PASSWORD_LENGTH) {
    out.push(`CHARTMATE_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; use a long random password.`);
  }
  // In a container the listen address is always non-loopback; what matters is where the port is published
  // (compose.yaml passes it as CHARTMATE_PUBLISHED_BIND, loopback by default).
  const exposed = c.publishedBind ?? c.host;
  if (c.password === null && !isLoopbackAddress(c.host) && !isLoopbackAddress(exposed)) {
    out.push(
      `Reachable on ${exposed} without CHARTMATE_PASSWORD: anyone who can reach this port and use an allowed host ` +
      'name can read and change your data. Set CHARTMATE_PASSWORD unless only you can reach it.',
    );
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
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
    databaseUrl: e.DATABASE_URL,
    password,
    sessionSecret: e.CHARTMATE_SESSION_SECRET ?? null,
    cryptoProvider: e.CRYPTO_PROVIDER,
    binanceBaseUrl: e.BINANCE_BASE_URL.replace(/\/+$/, ''),
    providers: e.CHARTMATE_PROVIDERS,
    trustProxy: parseTrustProxy(e.CHARTMATE_TRUST_PROXY),
    allowedHosts: parseAllowedHosts(e.CHARTMATE_ALLOWED_HOSTS),
    allowedOrigins: [],
    publishedBind: e.CHARTMATE_PUBLISHED_BIND ?? null,
    webDist: existsSync(join(webDistCandidate, 'index.html')) ? webDistCandidate : null,
  };
}

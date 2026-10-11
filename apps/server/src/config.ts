import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(65_535).default(8787)),
  HOST: z.preprocess(blankToUndefined, z.string().trim().default('127.0.0.1')),
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().default('sqlite:./data/altv.db').refine(
    (u) => !u.startsWith('sqlite:') || u.slice('sqlite:'.length).trim() !== '',
    { message: 'sqlite: URL has an empty path (use e.g. sqlite:./data/altv.db)' },
  )),
  ALTV_PASSWORD: z.preprocess(blankToUndefined, z.string().optional()),
  ALTV_SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
  CRYPTO_PROVIDER: z.preprocess(blankToUndefined, z.enum(['binance', 'coinbase']).default('binance')),
  BINANCE_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://data-api.binance.vision')),
  ALTV_PROVIDERS: z.preprocess(blankToUndefined, z.enum(['live', 'fixture']).default('live')),
  ALTV_WEB_DIST: z.preprocess(blankToUndefined, z.string().optional()),
  ALTV_TRUST_PROXY: z.preprocess(blankToUndefined, z.string().optional()),
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid configuration: ${issue.path.join('.')}: ${issue.message}`);
  }
  const e = parsed.data;
  const password = e.ALTV_PASSWORD ?? null;
  const webDistCandidate = resolve(e.ALTV_WEB_DIST ?? DEFAULT_WEB_DIST);
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    password,
    sessionSecret: e.ALTV_SESSION_SECRET ?? sha256Hex('altv:' + (password ?? '')),
    cryptoProvider: e.CRYPTO_PROVIDER,
    binanceBaseUrl: e.BINANCE_BASE_URL.replace(/\/+$/, ''),
    providers: e.ALTV_PROVIDERS,
    trustProxy: parseTrustProxy(e.ALTV_TRUST_PROXY),
    webDist: existsSync(join(webDistCandidate, 'index.html')) ? webDistCandidate : null,
  };
}

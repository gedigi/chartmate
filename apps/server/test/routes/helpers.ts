import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { BasketService } from '../../src/baskets/service.js';
import type { Config } from '../../src/config.js';
import { createDb } from '../../src/db/connect.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { MarketDataService } from '../../src/market/service.js';
import { RequestQueue } from '../../src/providers/queue.js';
import { createRegistry } from '../../src/providers/registry.js';

export const DAY = 86_400_000;

export function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The configuration test apps start from (fixture providers, no password, a fixed session secret). */
export function testConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'sqlite::memory:',
    password: null,
    sessionSecret: 'test-secret-test-secret-test-secret',
    cryptoProvider: 'binance',
    binanceBaseUrl: 'http://unused',
    providers: 'fixture',
    webDist: null,
    trustProxy: false,
    allowedHosts: [],
    allowedOrigins: [],
  };
}

export interface TestApp { app: FastifyInstance; market: MarketDataService; baskets: BasketService; repos: Repos; close(): Promise<void> }

export async function makeApp(overrides: Partial<Config> = {}, opts: { now?: () => number } = {}): Promise<TestApp> {
  const h = createDb('sqlite::memory:');
  await migrate(h.db);
  const repos = createRepos(h.db, h.dialect);
  const registry = createRegistry({ mode: 'fixture', cryptoProvider: 'binance', binanceBaseUrl: 'http://unused' });
  const queues = {
    stock: new RequestQueue({ concurrency: 4, minIntervalMs: 0 }),
    crypto: new RequestQueue({ concurrency: 4, minIntervalMs: 0 }),
  };
  const market = new MarketDataService({ repos, registry, queues, ...(opts.now ? { now: opts.now } : {}) });
  const baskets = new BasketService({ repos, market, ...(opts.now ? { now: opts.now } : {}) });
  const config: Config = { ...testConfig(), ...overrides };
  const app = await buildApp({ config, repos, market, baskets, logger: false, now: opts.now });
  return {
    app,
    market,
    baskets,
    repos,
    async close() {
      await app.close();
      await h.close();
    },
  };
}

/** A two-version AAPL/BTC basket starting ~60 days ago. */
export function basketBody(name = 'Tech and Coins', now = Date.now()) {
  return {
    name,
    versions: [{ effectiveFrom: isoDate(now - 60 * DAY), weights: { 'stock:AAPL': 0.5, 'crypto:BTC': 0.5 } }],
  };
}

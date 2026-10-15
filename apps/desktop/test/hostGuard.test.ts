import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { BasketService } from '../../server/src/baskets/service.js';
import { migrate } from '../../server/src/db/migrations.js';
import { createRepos } from '../../server/src/db/repos.js';
import { MarketDataService } from '../../server/src/market/service.js';
import { createRegistry } from '../../server/src/providers/registry.js';
import { desktopConfig } from '../src/lib/desktopConfig.js';
import { APP_HOST, APP_ORIGIN } from '../src/lib/hardening.js';
import { createNodeSqliteDb, type NodeSqliteHandle } from '../src/lib/nodeSqlite.js';
import { createAppProtocolHandler } from '../src/lib/protocol.js';

// The embedded server's Host / Origin guard (no password on desktop) must let the app:// renderer through:
// fastify.inject requests carry no Host of the renderer's, and state-changing fetches carry Origin app://chartmate.
describe('desktop app:// requests pass the server Host and Origin guard', () => {
  let dir: string;
  let handle: NodeSqliteHandle;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let handler: ReturnType<typeof createAppProtocolHandler>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chartmate-desktop-host-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const { config, dbPath } = desktopConfig({ userData: dir, env: { CHARTMATE_PROVIDERS: 'fixture' } });
    handle = createNodeSqliteDb(dbPath);
    await migrate(handle.db);
    const repos = createRepos(handle.db, 'sqlite');
    const registry = createRegistry({ mode: 'fixture', cryptoProvider: 'binance', binanceBaseUrl: config.binanceBaseUrl });
    const market = new MarketDataService({ repos, registry });
    server = await buildApp({ config, repos, market, baskets: new BasketService({ repos, market }) });
    await server.ready();
    handler = createAppProtocolHandler({
      webRoot: dir,
      host: APP_HOST,
      inject: async (r) => {
        const res = await server.inject({
          method: r.method as 'GET', url: r.url, headers: r.headers, ...(r.payload !== undefined ? { payload: r.payload } : {}),
        });
        return { statusCode: res.statusCode, headers: res.headers, rawPayload: res.rawPayload };
      },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows no extra host and only the renderer origin; the environment cannot widen either', () => {
    const { config } = desktopConfig({ userData: dir, env: { CHARTMATE_ALLOWED_HOSTS: 'evil.example' } });
    expect(config.allowedHosts).toEqual([]);
    expect(config.allowedOrigins).toEqual([APP_ORIGIN]);
  });

  it('GET and a state-changing request from app://chartmate succeed', async () => {
    expect((await handler(new Request(`${APP_ORIGIN}/api/health`))).status).toBe(200);
    const put = await handler(new Request(`${APP_ORIGIN}/api/watchlist`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: APP_ORIGIN }, body: '[]',
    }));
    expect(put.status).toBeLessThan(300);
  });

  // Chromium (Electron 44, checked with a probe page fetching its own app:// origin) sends neither Sec-Fetch-Site
  // nor Origin on app:// requests, so the server's fetch-metadata rule never sees them; if it ever does, the
  // renderer's own requests are same-origin and still pass.
  it('the Sec-Fetch-Site rule: absent or same-origin passes through the handler, cross-site is refused', async () => {
    expect((await handler(new Request(`${APP_ORIGIN}/api/watchlist`))).status).toBe(200);
    const same = await handler(new Request(`${APP_ORIGIN}/api/watchlist`, { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(same.status).toBe(200);
    for (const site of ['cross-site', 'same-site']) {
      const r = await handler(new Request(`${APP_ORIGIN}/api/watchlist`, { headers: { 'sec-fetch-site': site } }));
      expect(r.status, site).toBe(403);
    }
  });

  it('a state-changing request with a foreign Origin is still refused', async () => {
    const put = await handler(new Request(`${APP_ORIGIN}/api/watchlist`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '[]',
    }));
    expect(put.status).toBe(403);
  });
});

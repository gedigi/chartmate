import { BasketService } from './baskets/service.js';
import { buildApp } from './app.js';
import { configWarnings, loadConfig } from './config.js';
import { createDb } from './db/connect.js';
import { migrate } from './db/migrations.js';
import { createRepos } from './db/repos.js';
import { MarketDataService } from './market/service.js';
import { createRegistry } from './providers/registry.js';
import { serverVersion } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { db, dialect, close } = createDb(config.databaseUrl);
  await migrate(db);
  const repos = createRepos(db, dialect);
  const registry = createRegistry({
    mode: config.providers, cryptoProvider: config.cryptoProvider, binanceBaseUrl: config.binanceBaseUrl,
  });
  const market = new MarketDataService({ repos, registry });
  const baskets = new BasketService({ repos, market });
  const version = serverVersion();
  const app = await buildApp({ config, repos, market, baskets, logger: true, version });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  for (const w of configWarnings(config)) app.log.warn(w);
  await app.listen({ host: config.host, port: config.port });
  const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  app.log.info(
    `Chartmate ${version ?? '(unknown version)'} listening on http://${shownHost}:${config.port} (${dialect}, providers=${config.providers}, ` +
    `auth ${config.password !== null ? 'enabled' : 'disabled'}, web ${config.webDist ?? 'not served'})`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

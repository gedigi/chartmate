import { BinanceProvider } from './binance.js';
import { CoinbaseProvider } from './coinbase.js';
import { FixtureProvider } from './fixture.js';
import type { MarketDataProvider } from './types.js';
import { createYahooClient, YahooProvider, type YahooLike } from './yahoo.js';

export interface ProviderRegistry { stock: MarketDataProvider; crypto: MarketDataProvider }

export interface RegistryConfig {
  mode: 'live' | 'fixture';
  cryptoProvider: 'binance' | 'coinbase';
  binanceBaseUrl: string;
  fetchImpl?: typeof fetch;
  yahooClient?: YahooLike;
}

export function createRegistry(cfg: RegistryConfig): ProviderRegistry {
  if (cfg.mode === 'fixture') {
    return { stock: new FixtureProvider({ assetClass: 'stock' }), crypto: new FixtureProvider({ assetClass: 'crypto' }) };
  }
  const stock = new YahooProvider({ client: cfg.yahooClient ?? createYahooClient() });
  const crypto = cfg.cryptoProvider === 'coinbase'
    ? new CoinbaseProvider({ fetchImpl: cfg.fetchImpl })
    : new BinanceProvider({ baseUrl: cfg.binanceBaseUrl, fetchImpl: cfg.fetchImpl });
  return { stock, crypto };
}

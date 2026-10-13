/**
 * One-off fixture recorder for provider tests. Hits live APIs.
 * Run: pnpm --filter @chartmate/server exec tsx scripts/record-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const DAY = 86_400_000;
const MAX = 200;

function save(rel: string, data: unknown): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 1) + '\n');
  console.log('wrote', rel);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Chartmate' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function recordYahoo(): Promise<void> {
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const now = Date.now();

  const intraday = (await yf.chart('AAPL', {
    period1: new Date(now - 3 * DAY), period2: new Date(now), interval: '15m', includePrePost: true,
  })) as { meta: unknown; quotes: unknown[] };
  save('yahoo/aapl-15m.json', { meta: intraday.meta, quotes: intraday.quotes.slice(-MAX) });

  const daily = (await yf.chart('AAPL', {
    period1: new Date(now - 60 * DAY), period2: new Date(now), interval: '1d',
  })) as { meta: unknown; quotes: unknown[] };
  save('yahoo/aapl-1d.json', { meta: daily.meta, quotes: daily.quotes.slice(-MAX) });

  save('yahoo/search-apple.json', await yf.search('apple', { quotesCount: 20, newsCount: 0 }));
  save('yahoo/quote-aapl-spy.json', await yf.quote(['AAPL', 'SPY']));
}

async function recordBinance(): Promise<void> {
  const base = 'https://data-api.binance.vision';
  save('binance/klines-btcusdt-1h.json', await getJson(`${base}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50`));

  const info = (await getJson(`${base}/api/v3/exchangeInfo?permissions=SPOT`)) as {
    symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[];
  } & Record<string, unknown>;
  const pick = (pred: (s: (typeof info.symbols)[number]) => boolean) => {
    const s = info.symbols.find(pred);
    if (!s) throw new Error('exchangeInfo: symbol not found');
    return s;
  };
  const symbols = [
    pick((s) => s.symbol === 'BTCUSDT'),
    pick((s) => s.symbol === 'ETHUSDT'),
    pick((s) => s.symbol === 'SOLUSDT'),
    pick((s) => s.quoteAsset !== 'USDT' && s.baseAsset === 'BTC' && s.status === 'TRADING'),
    pick((s) => s.status === 'BREAK' && s.quoteAsset === 'USDT'),
  ];
  save('binance/exchange-info.json', { timezone: info.timezone, serverTime: info.serverTime, symbols });

  const syms = encodeURIComponent(JSON.stringify(['WALUSDT', 'SUIUSDT']));
  save('binance/ticker-tradingday.json', await getJson(`${base}/api/v3/ticker/tradingDay?symbols=${syms}&timeZone=0`));
}

async function recordCoinbase(): Promise<void> {
  const base = 'https://api.exchange.coinbase.com';
  const candles = (await getJson(`${base}/products/BTC-USD/candles?granularity=3600`)) as unknown[];
  save('coinbase/candles-btc-3600.json', candles.slice(0, 50));
  const products = (await getJson(`${base}/products`)) as { id: string; quote_currency: string }[];
  const wanted = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ETH-BTC', 'BTC-EUR'];
  save('coinbase/products.json', wanted.map((id) => products.find((p) => p.id === id)).filter(Boolean));
  save('coinbase/candles-btc-86400.json', ((await getJson(`${base}/products/BTC-USD/candles?granularity=86400`)) as unknown[]).slice(0, 3));
  save('coinbase/stats-btc.json', await getJson(`${base}/products/BTC-USD/stats`));
}

await recordYahoo();
await recordBinance();
await recordCoinbase();

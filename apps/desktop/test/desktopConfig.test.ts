import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_FILE_NAME, desktopConfig, resolveUserDataDir } from '../src/lib/desktopConfig.js';

const UD = '/Users/x/Library/Application Support/altv';

describe('desktopConfig', () => {
  it('defaults: SQLite in userData, live providers, auth disabled, no web dist (served by app://)', () => {
    const { config, dbPath } = desktopConfig({ userData: UD, env: {} });
    expect(dbPath).toBe(join(UD, DB_FILE_NAME));
    expect(DB_FILE_NAME).toBe('altv.db');
    expect(config.databaseUrl).toBe(`sqlite:${join(UD, 'altv.db')}`);
    expect(config.providers).toBe('live');
    expect(config.password).toBeNull();
    expect(config.cryptoProvider).toBe('binance');
    expect(config.binanceBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.webDist).toBeNull();
    expect(config.trustProxy).toBe(false);
  });

  it('never reads server-only settings from the environment (no password, listener or web dist overrides)', () => {
    const { config } = desktopConfig({
      userData: UD,
      env: { ALTV_PASSWORD: 'x', HOST: '0.0.0.0', PORT: '80', DATABASE_URL: 'postgres://h/db', ALTV_WEB_DIST: '/tmp', ALTV_TRUST_PROXY: 'true' },
    });
    expect(config.password).toBeNull();
    expect(config.host).toBe('127.0.0.1');
    expect(config.databaseUrl.startsWith('sqlite:')).toBe(true);
    expect(config.webDist).toBeNull();
    expect(config.trustProxy).toBe(false);
  });

  it('honors the provider overrides', () => {
    expect(desktopConfig({ userData: UD, env: { ALTV_PROVIDERS: 'fixture' } }).config.providers).toBe('fixture');
    expect(desktopConfig({ userData: UD, env: { CRYPTO_PROVIDER: 'coinbase' } }).config.cryptoProvider).toBe('coinbase');
    expect(desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'https://api.binance.com/' } }).config.binanceBaseUrl).toBe('https://api.binance.com');
  });

  it('rejects invalid overrides', () => {
    expect(() => desktopConfig({ userData: UD, env: { ALTV_PROVIDERS: 'mock' } })).toThrow(/ALTV_PROVIDERS/);
    expect(() => desktopConfig({ userData: UD, env: { CRYPTO_PROVIDER: 'kraken' } })).toThrow(/CRYPTO_PROVIDER/);
    expect(() => desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'http://api.binance.com' } })).toThrow(/https/);
    expect(() => desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'https://u:p@api.binance.com' } })).toThrow(/BINANCE_BASE_URL/);
    expect(() => desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'https://api.binance.com:8443' } })).toThrow(/BINANCE_BASE_URL/);
    expect(() => desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'nope' } })).toThrow(/BINANCE_BASE_URL/);
  });

  it('treats blank overrides as unset', () => {
    const { config } = desktopConfig({ userData: UD, env: { ALTV_PROVIDERS: ' ', CRYPTO_PROVIDER: '', BINANCE_BASE_URL: '' } });
    expect(config.providers).toBe('live');
    expect(config.cryptoProvider).toBe('binance');
  });

  it('requires an absolute userData path', () => {
    expect(() => desktopConfig({ userData: 'relative/dir', env: {} })).toThrow(/absolute/);
  });
});

describe('resolveUserDataDir', () => {
  it('uses the platform default unless ALTV_USER_DATA_DIR is an absolute path', () => {
    const dev = { allowOverride: true };
    expect(resolveUserDataDir(UD, {}, dev)).toBe(UD);
    expect(resolveUserDataDir(UD, { ALTV_USER_DATA_DIR: '/tmp/altv-test' }, dev)).toBe('/tmp/altv-test');
    expect(resolveUserDataDir(UD, { ALTV_USER_DATA_DIR: '' }, dev)).toBe(UD);
    expect(() => resolveUserDataDir(UD, { ALTV_USER_DATA_DIR: 'rel/dir' }, dev)).toThrow(/absolute/);
  });

  it('packaged builds ignore the override (like the refused --user-data-dir switch)', () => {
    const packaged = { allowOverride: false };
    expect(resolveUserDataDir(UD, { ALTV_USER_DATA_DIR: '/tmp/elsewhere' }, packaged)).toBe(UD);
    expect(resolveUserDataDir(UD, { ALTV_USER_DATA_DIR: 'rel/dir' }, packaged)).toBe(UD);
  });
});

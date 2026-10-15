import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, configOrExit, DB_FILE_NAME, DEFAULT_BINANCE_BASE_URL, desktopConfig, KNOWN_BINANCE_HOSTS, resolveUserDataDir } from '../src/lib/desktopConfig.js';

const UD = '/Users/x/Library/Application Support/Chartmate';

describe('desktopConfig', () => {
  it('defaults: SQLite in userData, live providers, auth disabled, no web dist (served by app://)', () => {
    const { config, dbPath } = desktopConfig({ userData: UD, env: {} });
    expect(dbPath).toBe(join(UD, DB_FILE_NAME));
    expect(DB_FILE_NAME).toBe('chartmate.db');
    expect(config.databaseUrl).toBe(`sqlite:${join(UD, 'chartmate.db')}`);
    expect(config.providers).toBe('live');
    expect(config.password).toBeNull();
    expect(config.cryptoProvider).toBe('binance');
    expect(config.binanceBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.webDist).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.allowedHosts).toEqual([]);
    expect(config.allowedOrigins).toEqual(['app://chartmate']);
  });

  it('never reads server-only settings from the environment (no password, listener or web dist overrides)', () => {
    const { config } = desktopConfig({
      userData: UD,
      env: {
        CHARTMATE_PASSWORD: 'x', HOST: '0.0.0.0', PORT: '80', DATABASE_URL: 'postgres://h/db', CHARTMATE_WEB_DIST: '/tmp',
        CHARTMATE_TRUST_PROXY: 'true', CHARTMATE_ALLOWED_HOSTS: 'evil.example',
      },
    });
    expect(config.password).toBeNull();
    expect(config.host).toBe('127.0.0.1');
    expect(config.databaseUrl.startsWith('sqlite:')).toBe(true);
    expect(config.webDist).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.allowedHosts).toEqual([]);
    expect(config.allowedOrigins).toEqual(['app://chartmate']);
  });

  it('honors the provider overrides', () => {
    expect(desktopConfig({ userData: UD, env: { CHARTMATE_PROVIDERS: 'fixture' } }).config.providers).toBe('fixture');
    expect(desktopConfig({ userData: UD, env: { CRYPTO_PROVIDER: 'coinbase' } }).config.cryptoProvider).toBe('coinbase');
    expect(desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'https://api.binance.com/' } }).config.binanceBaseUrl).toBe('https://api.binance.com');
  });

  it('rejects invalid overrides', () => {
    expect(() => desktopConfig({ userData: UD, env: { CHARTMATE_PROVIDERS: 'mock' } })).toThrow(/CHARTMATE_PROVIDERS/);
    expect(() => desktopConfig({ userData: UD, env: { CRYPTO_PROVIDER: 'kraken' } })).toThrow(/CRYPTO_PROVIDER/);
    expect(() => desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'http://api.binance.com' } })).toThrow(/https/);
    expect(() => desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'https://u:p@api.binance.com' } })).toThrow(/BINANCE_BASE_URL/);
    expect(() => desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'https://api.binance.com:8443' } })).toThrow(/BINANCE_BASE_URL/);
    expect(() => desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'nope' } })).toThrow(/BINANCE_BASE_URL/);
  });

  it('development (dev bundle) honors any https Binance-compatible endpoint', () => {
    expect(desktopConfig({ userData: UD, hardened: false, env: { BINANCE_BASE_URL: 'https://binance-mirror.example/api' } }).config.binanceBaseUrl)
      .toBe('https://binance-mirror.example/api');
  });

  it('hardened builds accept only the known Binance API hosts and ignore anything else (logged once)', () => {
    expect(KNOWN_BINANCE_HOSTS).toEqual(['data-api.binance.vision', 'api.binance.com', 'api.binance.us']);
    for (const h of KNOWN_BINANCE_HOSTS) {
      const notes: string[] = [];
      expect(desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: `https://${h}/` }, onIgnored: (m) => notes.push(m) }).config.binanceBaseUrl)
        .toBe(`https://${h}`);
      expect(notes).toEqual([]);
    }
    for (const raw of ['https://binance-mirror.example', 'https://api.binance.com.evil.example', 'https://api.binance.com/x',
      'http://api.binance.com', 'https://api.binance.com:8443', 'https://u:p@api.binance.com', 'nope']) {
      const notes: string[] = [];
      const { config } = desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: raw }, onIgnored: (m) => notes.push(m) });
      expect(config.binanceBaseUrl, raw).toBe(DEFAULT_BINANCE_BASE_URL);
      expect(notes, raw).toHaveLength(1);
      expect(notes[0]).toMatch(/BINANCE_BASE_URL/);
      expect(notes[0]).not.toContain(raw); // the value itself is not logged
    }
  });

  it('is hardened unless told otherwise', () => {
    expect(desktopConfig({ userData: UD, env: { BINANCE_BASE_URL: 'https://binance-mirror.example' } }).config.binanceBaseUrl)
      .toBe(DEFAULT_BINANCE_BASE_URL);
  });

  it('treats blank overrides as unset', () => {
    const { config } = desktopConfig({ userData: UD, env: { CHARTMATE_PROVIDERS: ' ', CRYPTO_PROVIDER: '', BINANCE_BASE_URL: '' } });
    expect(config.providers).toBe('live');
    expect(config.cryptoProvider).toBe('binance');
  });

  it('requires an absolute userData path', () => {
    expect(() => desktopConfig({ userData: 'relative/dir', env: {} })).toThrow(/absolute/);
  });
});

describe('resolveUserDataDir', () => {
  it('uses the platform default unless CHARTMATE_USER_DATA_DIR is an absolute path', () => {
    const dev = { allowOverride: true };
    expect(resolveUserDataDir(UD, {}, dev)).toBe(UD);
    expect(resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: '/tmp/chartmate-test' }, dev)).toBe('/tmp/chartmate-test');
    expect(resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: '' }, dev)).toBe(UD);
    expect(() => resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: 'rel/dir' }, dev)).toThrow(/absolute/);
  });

  it('packaged builds ignore the override (like the refused --user-data-dir switch)', () => {
    const packaged = { allowOverride: false };
    expect(resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: '/tmp/elsewhere' }, packaged)).toBe(UD);
    expect(resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: 'rel/dir' }, packaged)).toBe(UD);
  });
});

describe('configOrExit (invalid environment at startup)', () => {
  const deps = () => {
    const calls = { log: [] as string[], errors: [] as [string, string][], exit: [] as number[] };
    return {
      calls,
      d: {
        productName: 'Chartmate',
        log: (m: string) => { calls.log.push(m); },
        showError: (t: string, c: string) => { calls.errors.push([t, c]); },
        exit: ((code: number) => { calls.exit.push(code); throw new Error(`exit ${code}`); }) as (code: number) => never,
      },
    };
  };

  it('returns the value when the configuration is valid', () => {
    const { d, calls } = deps();
    expect(configOrExit(() => desktopConfig({ userData: UD, env: {} }).config.providers, d)).toBe('live');
    expect(calls.exit).toEqual([]);
  });

  it('an invalid provider variable: short error box naming it, logged, exit 1', () => {
    for (const env of [{ CHARTMATE_PROVIDERS: 'mock' }, { CRYPTO_PROVIDER: 'kraken' }]) {
      const { d, calls } = deps();
      expect(() => configOrExit(() => desktopConfig({ userData: UD, env }), d)).toThrow('exit 1');
      const name = Object.keys(env)[0]!;
      expect(calls.exit).toEqual([1]);
      expect(calls.errors).toHaveLength(1);
      expect(calls.errors[0]![0]).toBe('Chartmate cannot start');
      expect(calls.errors[0]![1]).toContain(name);
      expect(calls.errors[0]![1]).not.toMatch(/\n\s+at |\/Users\//);
      expect(calls.log.join('\n')).toContain(name);
    }
  });

  it('an unexpected error shows a generic message (no stack, no paths)', () => {
    const { d, calls } = deps();
    expect(() => configOrExit(() => { throw new Error('ENOENT: /Users/x/secret'); }, d)).toThrow('exit 1');
    expect(calls.errors[0]![1]).not.toContain('/Users/');
    expect(calls.errors[0]![1]).toMatch(/configuration/);
  });

  it('a relative CHARTMATE_USER_DATA_DIR is a configuration error too', () => {
    expect(() => resolveUserDataDir(UD, { CHARTMATE_USER_DATA_DIR: 'rel' }, { allowOverride: true })).toThrow(ConfigError);
  });
});

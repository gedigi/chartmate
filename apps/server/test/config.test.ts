import { describe, it, expect } from 'vitest';
import { configWarnings, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ CHARTMATE_WEB_DIST: '/definitely/not/here' });
    expect(c).toMatchObject({
      port: 8787, host: '127.0.0.1', databaseUrl: 'sqlite:./data/chartmate.db', password: null, cryptoProvider: 'binance',
      binanceBaseUrl: 'https://data-api.binance.vision', providers: 'live', webDist: null,
    });
    expect(c.sessionSecret).toBeNull();
  });

  it('never derives the session secret from the password: unset = generated and kept in the database', () => {
    const c = loadConfig({ CHARTMATE_PASSWORD: 'pw', PORT: '9000', CHARTMATE_PROVIDERS: 'fixture', CRYPTO_PROVIDER: 'coinbase' });
    expect(c).toMatchObject({ port: 9000, password: 'pw', providers: 'fixture', cryptoProvider: 'coinbase' });
    expect(c.sessionSecret).toBeNull();
    expect(loadConfig({ CHARTMATE_PASSWORD: 'pw', CHARTMATE_SESSION_SECRET: 's'.repeat(40) }).sessionSecret).toBe('s'.repeat(40));
  });

  it('refuses a password of only whitespace instead of silently disabling auth', () => {
    for (const pw of [' ', '\t', '  \n ']) expect(() => loadConfig({ CHARTMATE_PASSWORD: pw }), JSON.stringify(pw)).toThrow(/CHARTMATE_PASSWORD/);
    expect(loadConfig({ CHARTMATE_PASSWORD: ' a b ' }).password).toBe(' a b ');
  });

  it('warns about a short password and about listening beyond loopback without one', () => {
    const w = (env: Record<string, string>) => configWarnings(loadConfig(env));
    expect(w({})).toEqual([]);
    expect(w({ CHARTMATE_PASSWORD: 'correct-horse-battery' })).toEqual([]);
    expect(w({ CHARTMATE_PASSWORD: 'short' })).toEqual([expect.stringMatching(/shorter than 12/)]);
    expect(w({ HOST: '0.0.0.0' })).toEqual([expect.stringMatching(/without CHARTMATE_PASSWORD/)]);
    expect(w({ HOST: '::' })).toHaveLength(1);
    expect(w({ HOST: 'localhost' })).toEqual([]);
    expect(w({ HOST: '0.0.0.0', CHARTMATE_PASSWORD: 'correct-horse-battery' })).toEqual([]);
    // The default compose setup: the container listens on 0.0.0.0 but publishes on loopback only.
    expect(w({ HOST: '0.0.0.0', CHARTMATE_PUBLISHED_BIND: '127.0.0.1' })).toEqual([]);
    expect(w({ HOST: '0.0.0.0', CHARTMATE_PUBLISHED_BIND: '' })).toHaveLength(1); // unset: judged on HOST
    expect(w({ HOST: '0.0.0.0', CHARTMATE_PUBLISHED_BIND: '0.0.0.0' })).toEqual([expect.stringMatching(/Reachable on 0\.0\.0\.0/)]);
    expect(w({ HOST: '0.0.0.0', CHARTMATE_PUBLISHED_BIND: '192.168.1.10' })).toHaveLength(1);
  });

  it('treats an empty password as no password and rejects bad values', () => {
    expect(loadConfig({ CHARTMATE_PASSWORD: '' }).password).toBeNull();
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ CHARTMATE_PROVIDERS: 'mock' })).toThrow();
    expect(() => loadConfig({ CRYPTO_PROVIDER: 'kraken' })).toThrow();
  });

  it('parses CHARTMATE_TRUST_PROXY', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ CHARTMATE_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ CHARTMATE_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ CHARTMATE_TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ CHARTMATE_TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
  });

  it('parses CHARTMATE_ALLOWED_HOSTS and rejects invalid entries', () => {
    expect(loadConfig({}).allowedHosts).toEqual([]);
    expect(loadConfig({ CHARTMATE_ALLOWED_HOSTS: 'NAS.local, 192.168.1.10' }).allowedHosts).toEqual(['nas.local', '192.168.1.10']);
    expect(() => loadConfig({ CHARTMATE_ALLOWED_HOSTS: 'nas.local:8787' })).toThrow(/CHARTMATE_ALLOWED_HOSTS/);
    expect(loadConfig({ CHARTMATE_ALLOWED_HOSTS: 'chartmate_web' }).allowedHosts).toEqual(['chartmate_web']);
    expect(loadConfig({}).allowedOrigins).toEqual([]);
  });

  it('parses HOST (default 127.0.0.1; blank → default)', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ HOST: '::' }).host).toBe('::');
  });

  it('a blank BINANCE_BASE_URL or CRYPTO_PROVIDER (as compose.yaml forwards unset ones) uses the default', () => {
    expect(loadConfig({ BINANCE_BASE_URL: '' }).binanceBaseUrl).toBe('https://data-api.binance.vision');
    expect(loadConfig({ BINANCE_BASE_URL: '  ' }).binanceBaseUrl).toBe('https://data-api.binance.vision');
    expect(loadConfig({ BINANCE_BASE_URL: 'https://api.binance.example/' }).binanceBaseUrl).toBe('https://api.binance.example');
    expect(loadConfig({ CRYPTO_PROVIDER: '' }).cryptoProvider).toBe('binance');
  });

  it('BINANCE_BASE_URL must be an https URL without credentials, query or fragment', () => {
    for (const bad of ['http://api.binance.example', 'ftp://x.example', 'https://user:pw@x.example', 'https://x.example/?a=1', 'https://x.example/#f', 'https://x.example/?', 'https://x.example#', 'https://@x.example']) {
      expect(() => loadConfig({ BINANCE_BASE_URL: bad }), bad).toThrow(/BINANCE_BASE_URL/);
    }
    expect(loadConfig({ BINANCE_BASE_URL: 'https://x.example/base/' }).binanceBaseUrl).toBe('https://x.example/base');
  });

  it('rejects a sqlite: DATABASE_URL with an empty path', () => {
    expect(() => loadConfig({ DATABASE_URL: 'sqlite:' })).toThrow(/DATABASE_URL.*empty.*path/i);
    expect(() => loadConfig({ DATABASE_URL: 'sqlite:  ' })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: 'sqlite::memory:' }).databaseUrl).toBe('sqlite::memory:');
    expect(loadConfig({ DATABASE_URL: 'sqlite:/data/other.db' }).databaseUrl).toBe('sqlite:/data/other.db');
  });
});

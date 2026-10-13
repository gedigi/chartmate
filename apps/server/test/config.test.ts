import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ CHARTMATE_WEB_DIST: '/definitely/not/here' });
    expect(c).toMatchObject({
      port: 8787, host: '127.0.0.1', databaseUrl: 'sqlite:./data/chartmate.db', password: null, cryptoProvider: 'binance',
      binanceBaseUrl: 'https://data-api.binance.vision', providers: 'live', webDist: null,
    });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('derives the session secret from the password unless given', () => {
    const c = loadConfig({ CHARTMATE_PASSWORD: 'pw', PORT: '9000', CHARTMATE_PROVIDERS: 'fixture', CRYPTO_PROVIDER: 'coinbase' });
    expect(c).toMatchObject({ port: 9000, password: 'pw', providers: 'fixture', cryptoProvider: 'coinbase' });
    expect(c.sessionSecret).toBe(createHash('sha256').update('chartmate:pw').digest('hex'));
    expect(loadConfig({ CHARTMATE_PASSWORD: 'pw', CHARTMATE_SESSION_SECRET: 's'.repeat(40) }).sessionSecret).toBe('s'.repeat(40));
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

  it('parses HOST (default 127.0.0.1; blank → default)', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ HOST: '::' }).host).toBe('::');
  });

  it('rejects a sqlite: DATABASE_URL with an empty path', () => {
    expect(() => loadConfig({ DATABASE_URL: 'sqlite:' })).toThrow(/DATABASE_URL.*empty.*path/i);
    expect(() => loadConfig({ DATABASE_URL: 'sqlite:  ' })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: 'sqlite::memory:' }).databaseUrl).toBe('sqlite::memory:');
    expect(loadConfig({ DATABASE_URL: 'sqlite:/data/other.db' }).databaseUrl).toBe('sqlite:/data/other.db');
  });
});

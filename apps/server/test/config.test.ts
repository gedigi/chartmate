import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ALTV_WEB_DIST: '/definitely/not/here' });
    expect(c).toMatchObject({
      port: 8787, databaseUrl: 'sqlite:./data/altv.db', password: null, cryptoProvider: 'binance',
      binanceBaseUrl: 'https://data-api.binance.vision', providers: 'live', webDist: null,
    });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('derives the session secret from the password unless given', () => {
    const c = loadConfig({ ALTV_PASSWORD: 'pw', PORT: '9000', ALTV_PROVIDERS: 'fixture', CRYPTO_PROVIDER: 'coinbase' });
    expect(c).toMatchObject({ port: 9000, password: 'pw', providers: 'fixture', cryptoProvider: 'coinbase' });
    expect(c.sessionSecret).toBe(createHash('sha256').update('altv:pw').digest('hex'));
    expect(loadConfig({ ALTV_PASSWORD: 'pw', ALTV_SESSION_SECRET: 's'.repeat(40) }).sessionSecret).toBe('s'.repeat(40));
  });

  it('treats an empty password as no password and rejects bad values', () => {
    expect(loadConfig({ ALTV_PASSWORD: '' }).password).toBeNull();
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ ALTV_PROVIDERS: 'mock' })).toThrow();
    expect(() => loadConfig({ CRYPTO_PROVIDER: 'kraken' })).toThrow();
  });

  it('parses ALTV_TRUST_PROXY', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ ALTV_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ALTV_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ALTV_TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ ALTV_TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
  });
});

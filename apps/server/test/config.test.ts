import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { loadConfig, resolveLegacySqliteUrl } from '../src/config.js';
import { brandEnv, shadowedLegacyVars } from '../src/brandEnv.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ CHARTMATE_WEB_DIST: '/definitely/not/here' }, { fileExists: () => false });
    expect(c).toMatchObject({
      port: 8787, host: '127.0.0.1', databaseUrl: 'sqlite:./data/chartmate.db', password: null, cryptoProvider: 'binance',
      binanceBaseUrl: 'https://data-api.binance.vision', providers: 'live', webDist: null,
    });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('derives the session secret from the password unless given', () => {
    const c = loadConfig({ CHARTMATE_PASSWORD: 'pw', PORT: '9000', CHARTMATE_PROVIDERS: 'fixture', CRYPTO_PROVIDER: 'coinbase' });
    expect(c).toMatchObject({ port: 9000, password: 'pw', providers: 'fixture', cryptoProvider: 'coinbase' });
    expect(c.sessionSecret).toBe(createHash('sha256').update('altv:pw').digest('hex'));
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
    expect(loadConfig({ DATABASE_URL: 'sqlite:/data/altv.db' }).databaseUrl).toBe('sqlite:/data/altv.db');
  });

  it('accepts the legacy ALTV_* variables when the CHARTMATE_* one is not set', () => {
    const c = loadConfig({
      ALTV_PASSWORD: 'pw', ALTV_SESSION_SECRET: 'l'.repeat(40), ALTV_PROVIDERS: 'fixture', ALTV_TRUST_PROXY: '1',
      ALTV_WEB_DIST: '/definitely/not/here',
    });
    expect(c).toMatchObject({ password: 'pw', sessionSecret: 'l'.repeat(40), providers: 'fixture', trustProxy: 1, webDist: null });
    // Session secret derived from a legacy password is unchanged (existing cookies stay valid).
    expect(loadConfig({ ALTV_PASSWORD: 'pw' }).sessionSecret).toBe(createHash('sha256').update('altv:pw').digest('hex'));
    expect(() => loadConfig({ ALTV_PROVIDERS: 'mock' })).toThrow(/CHARTMATE_PROVIDERS/);
  });

  it('prefers CHARTMATE_* over ALTV_*, even when the new variable is empty', () => {
    expect(loadConfig({ CHARTMATE_PASSWORD: 'new', ALTV_PASSWORD: 'old' }).password).toBe('new');
    expect(loadConfig({ CHARTMATE_PASSWORD: '', ALTV_PASSWORD: 'old' }).password).toBeNull();
    expect(loadConfig({ CHARTMATE_TRUST_PROXY: 'true', ALTV_TRUST_PROXY: '2' }).trustProxy).toBe(true);
    expect(brandEnv({ ALTV_X: 'a' }, 'X')).toBe('a');
    expect(brandEnv({ CHARTMATE_X: 'b', ALTV_X: 'a' }, 'X')).toBe('b');
    expect(brandEnv({}, 'X')).toBeUndefined();
  });

  it('keeps using an existing altv.db when chartmate.db does not exist yet', () => {
    const files = (...present: string[]) => (p: string) => present.includes(p);
    // Fresh install: the new name.
    expect(loadConfig({}, { fileExists: files() }).databaseUrl).toBe('sqlite:./data/chartmate.db');
    // Upgrade: the old default file is kept.
    expect(loadConfig({}, { fileExists: files('data/altv.db') }).databaseUrl).toBe('sqlite:./data/altv.db');
    // Both exist: the new one wins.
    expect(loadConfig({}, { fileExists: files('./data/chartmate.db', 'data/altv.db') }).databaseUrl).toBe('sqlite:./data/chartmate.db');
    // Docker volume (absolute path).
    expect(resolveLegacySqliteUrl('sqlite:/data/chartmate.db', files('/data/altv.db'))).toBe('sqlite:/data/altv.db');
    // Other names and Postgres are never rewritten.
    expect(resolveLegacySqliteUrl('sqlite:/data/mine.db', files('/data/altv.db'))).toBe('sqlite:/data/mine.db');
    expect(resolveLegacySqliteUrl('postgres://h/chartmate.db', () => true)).toBe('postgres://h/chartmate.db');
  });
});

describe('shadowedLegacyVars', () => {
  it('lists ALTV_ vars overridden by a present CHARTMATE_ var, even an empty one', () => {
    const env = { CHARTMATE_PASSWORD: '', ALTV_PASSWORD: 'x', ALTV_PROVIDERS: 'live', CHARTMATE_WEB_DIST: '/w' };
    expect(shadowedLegacyVars(env, ['PASSWORD', 'PROVIDERS', 'WEB_DIST'])).toEqual(['ALTV_PASSWORD']);
  });
});

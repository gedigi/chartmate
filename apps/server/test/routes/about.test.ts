import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { serverVersion } from '../../src/version.js';
import { makeApp, type TestApp } from './helpers.js';

describe('GET /api/about', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('reports the version the server was started with (null when it was not given one)', async () => {
    t = await makeApp({}, { version: '1.2.3' });
    const r = await t.app.inject({ method: 'GET', url: '/api/about' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: '1.2.3' });
    await t.close();
    t = await makeApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/about' })).json()).toEqual({ version: null });
  });

  it('needs a login like the rest of the API when a password is set (the version is not public)', async () => {
    t = await makeApp({ password: 'correct-horse-battery' }, { version: '1.2.3' });
    expect((await t.app.inject({ method: 'GET', url: '/api/about' })).statusCode).toBe(401);
  });
});

describe('serverVersion', () => {
  it('is the server package version (the product version; the Docker image ships that package.json)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(serverVersion()).toBe(pkg.version);
  });

  it('is null when package.json is missing or has no usable version', () => {
    expect(serverVersion(() => { throw new Error('ENOENT'); })).toBeNull();
    expect(serverVersion(() => '{"name":"x"}')).toBeNull();
    expect(serverVersion(() => '{"version":"1.0.0\\n<script>"}')).toBeNull();
    expect(serverVersion(() => 'not json')).toBeNull();
    expect(serverVersion(() => '{"version":"2.0.0-beta.1"}')).toBe('2.0.0-beta.1');
  });
});

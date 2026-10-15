import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, SOURCE_REF, SOURCE_URL } from '../src/buildInfo';

const require = createRequire(resolve(__dirname, 'buildInfo.test.ts'));
const { repositoryUrl } = require('../build/repository.cjs') as typeof import('../build/repository.d.cts');
const { sourceRef } = require('../build/sourceRef.cjs') as typeof import('../build/sourceRef.d.cts');

describe('repositoryUrl (build time, from GITHUB_REPOSITORY)', () => {
  it('derives the repository URL from an owner/name slug', () => {
    expect(repositoryUrl('octo-org/chart.mate_2')).toBe('https://github.com/octo-org/chart.mate_2');
  });

  it('rejects anything that is not a plain GitHub slug', () => {
    for (const r of [undefined, null, '', 'owner', 'owner/', '/repo', 'a/b/c', 'a/..', 'a/.', '-a/b', 'a b/c', 'a/b?x', 'a/b#x',
      'a@x/b', 'evil.com/x', `${'a'.repeat(40)}/b`, 'a/b\n', 'javascript:alert(1)/x', 42]) {
      expect(repositoryUrl(r), String(r)).toBeNull();
    }
  });
});

describe('sourceRef (build time, from GITHUB_REF_TYPE, GITHUB_REF_NAME and GITHUB_SHA)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('the release tag only for a build of exactly that tag', () => {
    expect(sourceRef({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: SHA }, '1.2.3')).toBe('v1.2.3');
    expect(sourceRef({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.3.0-beta.1' }, '1.3.0-beta.1')).toBe('v1.3.0-beta.1');
  });

  it('any other build from a commit: that commit (a commit after a release is not the release)', () => {
    expect(sourceRef({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: SHA }, '1.2.3')).toBe(SHA);
    expect(sourceRef({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: SHA }, '1.2.3')).toBe(SHA);
    expect(sourceRef({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.2', GITHUB_SHA: SHA }, '1.2.3')).toBe(SHA);
    expect(sourceRef({ GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: SHA }, '1.2.3')).toBe(SHA);
    expect(sourceRef({ GITHUB_SHA: 'a'.repeat(64) }, '1.2.3')).toBe('a'.repeat(64));
  });

  it('nothing usable: null (the dialog links the repository)', () => {
    expect(sourceRef({}, '1.2.3')).toBeNull();
    for (const sha of ['', 'main', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}\n`, `${SHA}/../x`, `${SHA}0`, 'g'.repeat(40)]) {
      expect(sourceRef({ GITHUB_SHA: sha }, '1.2.3'), sha).toBeNull();
    }
    // An unusual version never yields a tag, whatever the ref says.
    expect(sourceRef({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'vlocal build' }, 'local build')).toBeNull();
    expect(sourceRef({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3/../x' }, '1.2.3/../x')).toBeNull();
  });
});

describe('build info baked in by vite.config.ts', () => {
  it('the version is the web package version, which follows the product version', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('the source URL is the validated GITHUB_REPOSITORY, or null when unset or invalid', () => {
    expect(SOURCE_URL).toBe(repositoryUrl(process.env['GITHUB_REPOSITORY']));
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toMatch(/__CHARTMATE_SOURCE_URL__: JSON\.stringify\(repositoryUrl\(process\.env\.GITHUB_REPOSITORY\) \?\? ''\)/);
  });

  it('the source ref is derived from the GitHub ref variables and the version, or null', () => {
    expect(SOURCE_REF).toBe(sourceRef(process.env, APP_VERSION));
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toMatch(/__CHARTMATE_SOURCE_REF__: JSON\.stringify\(sourceRef\(process\.env, version\) \?\? ''\)/);
  });
});

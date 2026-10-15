import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, SOURCE_URL } from '../src/buildInfo';

const require = createRequire(resolve(__dirname, 'buildInfo.test.ts'));
const { repositoryUrl } = require('../build/repository.cjs') as typeof import('../build/repository.d.cts');

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
});

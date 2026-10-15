import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');

/** Whether the Docker build context keeps `path` (simple .dockerignore semantics: the last matching rule wins). */
function inContext(path: string): boolean {
  const rules = readFileSync(resolve(REPO, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let kept = true;
  for (const rule of rules) {
    const negated = rule.startsWith('!');
    const pattern = (negated ? rule.slice(1) : rule).replace(/^\//, '');
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(.*/)?')}(/.*)?$`);
    if (re.test(path)) kept = negated;
  }
  return kept;
}

describe('Docker build context', () => {
  // The image runs `pnpm build`, whose web step typechecks the tests, and the scaffold test imports this script.
  it('keeps the files the web build typechecks, even under excluded folders', () => {
    expect(inContext('scripts/new-indicator.mjs')).toBe(true);
    expect(inContext('scripts/new-indicator.d.mts')).toBe(true);
    expect(inContext('apps/web/test/scaffold/newIndicator.test.ts')).toBe(true);
  });

  it('keeps what the image ships besides the build: the license and the notices generator', () => {
    expect(inContext('LICENSE')).toBe(true);
    expect(inContext('scripts/third-party-notices.mjs')).toBe(true);
  });

  it('keeps the corepack installer the build stage gets pnpm with, and nothing else under .github', () => {
    expect(inContext('.github/scripts/install-corepack.sh')).toBe(true);
    expect(inContext('.github/scripts/macos-sign.sh')).toBe(false);
    expect(inContext('.github/workflows/docker.yml')).toBe(false);
  });

  it('never sends environment files, at any depth (the template is not needed either)', () => {
    for (const f of ['.env', '.env.local', 'apps/server/.env', 'apps/server/.env.production', 'e2e/.env', 'apps/web/.env.local', '.env.example']) {
      expect(inContext(f), f).toBe(false);
    }
  });

  it('still leaves out what the image does not need', () => {
    expect(inContext('scripts/docker-smoke.sh')).toBe(false);
    expect(inContext('apps/desktop/package.json')).toBe(false);
    expect(inContext('apps/server/data/chartmate.db')).toBe(false);
  });
});

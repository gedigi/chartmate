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
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(.*/)?').replace(/\*/g, '[^/]*')}(/.*)?$`);
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

  it('still leaves out what the image does not need', () => {
    expect(inContext('scripts/docker-smoke.sh')).toBe(false);
    expect(inContext('apps/desktop/package.json')).toBe(false);
    expect(inContext('apps/server/data/chartmate.db')).toBe(false);
  });
});

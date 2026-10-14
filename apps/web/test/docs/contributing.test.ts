import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../../..');

/** Code blocks of CONTRIBUTING.md marked `<!-- snippet: <path> -->`, with the file each is copied from. */
function snippets(): Array<{ path: string; code: string }> {
  const doc = readFileSync(resolve(REPO, 'CONTRIBUTING.md'), 'utf8');
  return [...doc.matchAll(/<!-- snippet: (\S+) -->\n```\w*\n([\s\S]*?)```/g)].map((m) => ({ path: m[1]!, code: m[2]! }));
}

describe('CONTRIBUTING.md', () => {
  it('has the worked example snippets', () => {
    const paths = new Set(snippets().map((s) => s.path));
    expect([...paths].sort()).toEqual(['apps/web/src/chart/indicators/custom/ppo.ts', 'apps/web/test/indicators/ppo.test.ts']);
  });

  it.each(snippets().map((s, i) => [i, s.path, s.code] as const))('snippet %i is copied verbatim from %s', (_i, path, code) => {
    const file = resolve(REPO, path);
    expect(existsSync(file), path).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(code);
  });
});

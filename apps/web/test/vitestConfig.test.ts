// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import config, { globsSkipFsModuleCache } from '../vitest.config';

type Generator = (ctx: { id: string; sourceCode: string }) => string | undefined | null | false;

/** The cache key generator the plugin registers with Vitest. */
function generator(): Generator {
  const generators: Generator[] = [];
  const hook = globsSkipFsModuleCache().configureVitest as (ctx: { defineCacheKeyGenerator: (g: Generator) => void }) => void;
  hook({ defineCacheKeyGenerator: (g) => generators.push(g) });
  expect(generators).toHaveLength(1);
  return generators[0]!;
}

// Vitest's fs module cache keys a module on its own source only, so a module whose import.meta.glob expansion is
// cached never sees files added to the globbed directory later (e.g. by `pnpm new:indicator`). Vitest skips modules
// containing `import.meta.glob(`, which misses a typed call such as `import.meta.glob<T>(...)`.
describe('globsSkipFsModuleCache', () => {
  it('is registered in the test config', () => {
    const names = ((config.plugins ?? []) as unknown[]).flat(Infinity).map((p) => (p as Plugin | null)?.name);
    expect(names).toContain(globsSkipFsModuleCache().name);
  });

  it('keeps the custom indicator loader out of the fs module cache', () => {
    const path = new URL('../src/chart/indicators/extensions.ts', import.meta.url);
    expect(generator()({ id: path.pathname, sourceCode: readFileSync(path, 'utf8') })).toBe(false);
  });

  it.each([
    ["import.meta.glob('./a/*.ts')"],
    ["import.meta.glob<{ default?: unknown }>('./a/*.ts', { eager: true })"],
    ["import.meta.glob ('./a/*.ts')"],
    ["import.meta\n  .glob('./a/*.ts')"],
  ])('bails out on %j', (sourceCode) => {
    expect(generator()({ id: '/src/x.ts', sourceCode })).toBe(false);
  });

  it('leaves other modules cacheable', () => {
    expect(generator()({ id: '/src/x.ts', sourceCode: "import { a } from './a';\nexport const globby = import.meta.url;" })).toBeUndefined();
  });
});

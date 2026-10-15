import type { Plugin } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/**
 * Keeps modules that call `import.meta.glob` out of Vitest's fs module cache (`fsModuleCache`, on by default).
 * That cache keys a module on its own source, so a cached glob expansion never sees files added to the globbed
 * directory later: a new `src/chart/indicators/custom/*.ts` (e.g. from `pnpm new:indicator`) would be missing from
 * CUSTOM_INDICATORS until the cache is cleared. Vitest skips such modules itself only when the source contains
 * `import.meta.glob(` verbatim, which misses a typed call like `import.meta.glob<T>(...)`.
 */
export function globsSkipFsModuleCache(): Plugin {
  return {
    name: 'chartmate:globs-skip-fs-module-cache',
    configureVitest({ defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(({ sourceCode }) => (/\bimport\.meta\s*\.\s*glob\b/.test(sourceCode) ? false : undefined));
    },
  };
}

export default mergeConfig(viteConfig, defineConfig({
  plugins: [globsSkipFsModuleCache()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
}));

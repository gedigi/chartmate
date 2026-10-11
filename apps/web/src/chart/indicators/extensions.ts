import type { CustomIndicator } from './types';

/**
 * Every module in ./custom/ (bundled at build time). Each must `export default { template, catalog }`
 * (see CustomIndicator); malformed modules are skipped with a console warning.
 */
const modules = import.meta.glob<{ default?: unknown }>('./custom/*.ts', { eager: true });

function isCustomIndicator(v: unknown): v is CustomIndicator {
  if (!v || typeof v !== 'object') return false;
  const { template, catalog } = v as Partial<CustomIndicator>;
  return typeof template?.name === 'string' && typeof template.calc === 'function'
    && typeof catalog?.name === 'string' && catalog.name === template.name
    && (catalog.pane === 'main' || catalog.pane === 'sub')
    && Array.isArray(catalog.defaultParams) && Array.isArray(catalog.paramLabels)
    && catalog.paramLabels.length === catalog.defaultParams.length && Array.isArray(catalog.lines);
}

export const CUSTOM_INDICATORS: readonly CustomIndicator[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([path, mod]) => {
    if (isCustomIndicator(mod.default)) return [mod.default];
    console.warn(`[indicators] ${path}: default export must be { template, catalog } with matching names; skipped`);
    return [];
  });

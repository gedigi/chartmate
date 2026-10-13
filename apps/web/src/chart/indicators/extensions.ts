import type { CustomIndicator } from './types';

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Why `v` is not a valid CustomIndicator default export, or null when it is. */
export function customIndicatorProblem(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'default export must be an object { template, catalog }';
  const { template, catalog, usePricePrecision } = v as Partial<Record<keyof CustomIndicator, unknown>>;
  const t = template as { name?: unknown; calc?: unknown } | undefined;
  if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) return 'template.name must be a non-empty string';
  if (typeof t.calc !== 'function') return 'template.calc must be a function';
  const c = catalog as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return 'catalog must be an object';
  if (c.name !== t.name) return 'catalog.name must equal template.name';
  if (typeof c.label !== 'string' || !c.label) return 'catalog.label must be a non-empty string';
  if (c.pane !== 'main' && c.pane !== 'sub') return "catalog.pane must be 'main' or 'sub'";
  if (!Array.isArray(c.defaultParams) || !c.defaultParams.every((p) => typeof p === 'number' && Number.isFinite(p))) {
    return 'catalog.defaultParams must be an array of finite numbers';
  }
  if (!isStringArray(c.paramLabels)) return 'catalog.paramLabels must be an array of strings';
  if (c.paramLabels.length !== c.defaultParams.length) return 'catalog.paramLabels must have one label per default param';
  if (!isStringArray(c.lines)) return 'catalog.lines must be an array of strings';
  if (c.decimalParams !== undefined && !(Array.isArray(c.decimalParams) && c.decimalParams.every((i) => Number.isInteger(i)))) {
    return 'catalog.decimalParams must be an array of param indices';
  }
  for (const key of ['paramMin', 'paramMax'] as const) {
    const v = c[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
      return `catalog.${key} must be an array of finite numbers`;
    }
  }
  if (c.description !== undefined && typeof c.description !== 'string') return 'catalog.description must be a string';
  if (usePricePrecision !== undefined && typeof usePricePrecision !== 'boolean') return 'usePricePrecision must be a boolean';
  return null;
}

/** Valid custom indicators from glob-imported modules (sorted by path); invalid ones are skipped with a warning. */
export function collectCustomIndicators(modules: Record<string, { default?: unknown }>): CustomIndicator[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, mod]) => {
      const problem = customIndicatorProblem(mod.default);
      if (problem === null) return [mod.default as CustomIndicator];
      console.warn(`[indicators] ${path}: ${problem}; skipped`);
      return [];
    });
}

/**
 * Every module in ./custom/ (bundled at build time). Each must `export default { template, catalog }`
 * (see CustomIndicator in types.ts).
 */
export const CUSTOM_INDICATORS: readonly CustomIndicator[] = collectCustomIndicators(
  import.meta.glob<{ default?: unknown }>('./custom/*.ts', { eager: true }),
);

/** Names of custom indicators whose values are formatted with the symbol's price precision. */
export const PRICE_PRECISION_INDICATORS: ReadonlySet<string> = new Set(
  CUSTOM_INDICATORS.filter((c) => c.usePricePrecision).map((c) => c.template.name),
);

#!/usr/bin/env node
// Scaffolds a custom indicator wired to the palette, plus its test:
//
//   pnpm new:indicator <Name> [--pane sub|main]
//
// creates apps/web/src/chart/indicators/custom/<name>.ts and apps/web/test/indicators/<name>.test.ts.
// See CONTRIBUTING.md, "Add an indicator".
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDICATORS_DIR = 'apps/web/src/chart/indicators';
export const CUSTOM_DIR = `${INDICATORS_DIR}/custom`;
export const TEST_DIR = 'apps/web/test/indicators';

const NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,23}$/;

/**
 * Names derived from the CLI argument, or an Error explaining why it is not usable. `Name` is PascalCase or an
 * acronym (`KeltnerChannels`, `TSI`): the file is `keltnerChannels.ts` / `tsi.ts`, the template name `KELTNERCHANNELS` /
 * `TSI`, the label `Keltner channels` / `TSI`.
 */
export function indicatorSpec(name, pane = 'sub') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`invalid name ${JSON.stringify(name ?? '')}: use 2-24 letters and digits starting with a letter, e.g. KeltnerChannels or TSI`);
  }
  if (pane !== 'sub' && pane !== 'main') throw new Error(`invalid pane ${JSON.stringify(pane)}: use sub or main`);
  const acronym = name === name.toUpperCase();
  const id = acronym ? name.toLowerCase() : name[0].toLowerCase() + name.slice(1);
  const words = acronym ? [name] : name.split(/(?<=[a-z0-9])(?=[A-Z])/);
  const label = words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w === w.toUpperCase() ? w : w.toLowerCase())).join(' ');
  const pascal = name[0].toUpperCase() + name.slice(1);
  return { id, templateName: name.toUpperCase(), label, calcName: `calc${pascal}`, pane };
}

/** Template names already taken (built-ins in catalog.ts and every module in custom/), upper-cased. */
export function takenNames(root) {
  const sources = [join(root, INDICATORS_DIR, 'catalog.ts')];
  const customDir = join(root, CUSTOM_DIR);
  for (const f of readdirSync(customDir)) if (f.endsWith('.ts')) sources.push(join(customDir, f));
  const names = new Set();
  for (const f of sources) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bname: '([^']+)'/g)) names.add(m[1].toUpperCase());
  }
  return names;
}

export function indicatorSource(spec) {
  const { templateName, label, calcName, pane, id } = spec;
  const main = pane === 'main';
  return `import type { CustomIndicator } from '../types';

/**
 * The calculation: one result per bar, \`null\` while there is not enough history yet (the warm-up). Keep it pure (no
 * chart, no DOM, no globals) and test it in apps/web/test/indicators/${id}.test.ts.
 *
 * Placeholder: a simple moving average of the close. Replace it with the real formula.
 */
export function ${calcName}(bars: ReadonlyArray<{ close: number }>, period: number): Array<{ value: number | null }> {
  const n = Math.max(1, Math.floor(period));
  let sum = 0;
  return bars.map((bar, i) => {
    sum += bar.close;
    const dropped = bars[i - n];
    if (dropped) sum -= dropped.close;
    return { value: i >= n - 1 ? sum / n : null };
  });
}

/** ${label}: TODO one line on what it shows and how to read it. */
const indicator: CustomIndicator = {
  template: {
    name: '${templateName}',
    shortName: '${label}',
    calcParams: [14],
    // One figure per line, in the order of \`catalog.lines\`. No colors here: they come from the palette (lineSlots).
    figures: [{ key: 'value', title: '${label}: ', type: 'line' }],
    calc: (dataList, ind) => ${calcName}(dataList, ind.calcParams[0] ?? 14),
  },
  usePricePrecision: true, // values are prices: format them with the symbol's precision (drop it for ratios / percentages)
  catalog: {
    name: '${templateName}',
    label: '${label}',
    pane: '${pane}',
    defaultParams: [14],
    paramLabels: ['Period'],
    lines: ['${label}'],
    // Palette slot (0-5) of each line, index-aligned with \`lines\`; the color of each slot is set per theme.
${main
    ? '    // Price-pane overlays share the candles: MA uses slots 0-3 and VWAP 5, so this line takes 4.\n    lineSlots: [4],'
    : '    lineSlots: [0],\n    // levels: [0], // default dashed reference levels (e.g. [70, 30]); sub-pane indicators only'}
    // description: 'Longer explanation shown in the picker tooltip.',
  },
};

export default indicator;
`;
}

export function testSource(spec) {
  const { id, templateName, label, calcName, pane } = spec;
  return `import { describe, expect, it } from 'vitest';
import { catalogEntry, defaultLineColors } from '../../src/chart/indicators/catalog';
import indicator, { ${calcName} } from '../../src/chart/indicators/custom/${id}';
import { customIndicatorProblem } from '../../src/chart/indicators/extensions';
import { INDICATOR_PALETTE } from '../../src/chart/theme';

const bars = (closes: number[]) => closes.map((close) => ({ open: close, high: close, low: close, close, volume: 0, timestamp: 0 }));

describe('${calcName}', () => {
  it('is null during the warm-up, then follows the formula', () => {
    expect(${calcName}(bars([1, 2, 3, 4, 5]), 3).map((r) => r.value)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns one result per bar, and nothing for no bars', () => {
    expect(${calcName}(bars([1, 2]), 5)).toEqual([{ value: null }, { value: null }]);
    expect(${calcName}([], 14)).toEqual([]);
  });
});

describe('${label} indicator', () => {
  it('is a valid custom indicator, listed in the picker', () => {
    expect(customIndicatorProblem(indicator)).toBeNull();
    expect(catalogEntry('${templateName}')).toMatchObject({ label: '${label}', pane: '${pane}' });
  });

  it('runs the calculation with the indicator params', async () => {
    const out = await indicator.template.calc(bars([2, 4, 6]) as never, { calcParams: [2] } as never);
    expect(out).toEqual([{ value: null }, { value: 3 }, { value: 5 }]);
  });

  it.each(['dark', 'light'] as const)('draws every line in a distinct palette color on the %s theme', (theme) => {
    const slots = indicator.catalog.lineSlots ?? indicator.catalog.lines.map((_, i) => i);
    const colors = defaultLineColors('${templateName}', theme);
    expect(colors).toEqual(slots.map((s) => INDICATOR_PALETTE[theme][s]));
    expect(new Set(colors).size).toBe(colors.length);
  });
});
`;
}

/**
 * Writes the indicator and its test under the repo at `root`. Throws (and writes nothing) when the name is invalid
 * or taken, or when either file already exists. Returns the paths written, relative to `root`.
 */
export function createIndicator(name, { root, pane = 'sub' }) {
  const spec = indicatorSpec(name, pane);
  if (takenNames(root).has(spec.templateName)) {
    throw new Error(`an indicator named ${spec.templateName} already exists; pick another name`);
  }
  const files = [
    [join(CUSTOM_DIR, `${spec.id}.ts`), indicatorSource(spec)],
    [join(TEST_DIR, `${spec.id}.test.ts`), testSource(spec)],
  ];
  for (const [path] of files) {
    if (existsSync(join(root, path))) throw new Error(`${path} already exists; not overwriting it`);
  }
  for (const [path, source] of files) writeFileSync(join(root, path), source, { flag: 'wx' });
  return files.map(([path]) => path);
}

function main(argv) {
  const args = [...argv];
  let pane = 'sub';
  const paneAt = args.findIndex((a) => a === '--pane' || a.startsWith('--pane='));
  if (paneAt >= 0) {
    const [flag] = args.splice(paneAt, 1);
    pane = flag.includes('=') ? flag.slice('--pane='.length) : args.splice(paneAt, 1)[0];
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('usage: pnpm new:indicator <Name> [--pane sub|main]   e.g. pnpm new:indicator KeltnerChannels');
    return 1;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const written = createIndicator(args[0], { root, pane });
    for (const p of written) console.log(`created ${p}`);
    const testPath = relative(join(root, 'apps/web'), join(root, written[1]));
    console.log(`\nNext: write the calculation and its test, then run\n  pnpm --filter @chartmate/web exec vitest run ${testPath}\n` +
      'and open the indicator picker in `pnpm dev` (both themes). See CONTRIBUTING.md, "Add an indicator".');
    return 0;
  } catch (e) {
    console.error(`new:indicator: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

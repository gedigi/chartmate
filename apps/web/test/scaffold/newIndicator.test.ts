import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIndicator, CUSTOM_DIR, INDICATORS_DIR, indicatorSpec, parseArgs, takenNames, TEST_DIR, testSource,
} from '../../../../scripts/new-indicator.mjs';
import { CATALOG } from '../../src/chart/indicators/catalog';
import { customIndicatorProblem } from '../../src/chart/indicators/extensions';

const REPO = resolve(__dirname, '../../../..');
const SCRATCH = resolve(__dirname, '../../.scaffold-test');

describe('indicatorSpec', () => {
  it('derives the file, template, label and calc names from PascalCase or an acronym', () => {
    expect(indicatorSpec('KeltnerChannels')).toEqual({
      id: 'keltnerChannels', templateName: 'KELTNERCHANNELS', label: 'Keltner channels', calcName: 'calcKeltnerChannels', pane: 'sub',
    });
    expect(indicatorSpec('TSI', 'main')).toEqual({ id: 'tsi', templateName: 'TSI', label: 'TSI', calcName: 'calcTSI', pane: 'main' });
    expect(indicatorSpec('chandeKroll')).toMatchObject({ id: 'chandeKroll', label: 'Chande kroll', calcName: 'calcChandeKroll' });
  });

  it.each([[''], ['X'], ['1Ema'], ['Keltner-Channels'], ['Keltner Channels'], ['foo.ts'], ['../Up'], ['A'.repeat(25)]])('rejects the name %j', (name) => {
    expect(() => indicatorSpec(name)).toThrow(/invalid name/);
  });

  it('rejects an unknown pane', () => {
    expect(() => indicatorSpec('Foo', 'left')).toThrow(/invalid pane/);
  });
});

describe('parseArgs', () => {
  it('reads the name and the pane (default sub)', () => {
    expect(parseArgs(['Foo'])).toEqual({ name: 'Foo', pane: 'sub' });
    expect(parseArgs(['Foo', '--pane', 'main'])).toEqual({ name: 'Foo', pane: 'main' });
    expect(parseArgs(['--pane=main', 'Foo'])).toEqual({ name: 'Foo', pane: 'main' });
  });

  it.each([[['Foo', '--pane']], [['Foo', '--pane=']], [['--pane', '--x', 'Foo']]])('rejects a --pane without a value: %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/--pane needs a value/);
  });

  it.each([[[]], [['Foo', 'Bar']], [['--help']]])('rejects other argument lists with the usage: %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage: pnpm new:indicator/);
  });
});

describe('takenNames', () => {
  it('finds every indicator in the picker (built-ins and custom ones)', () => {
    const taken = takenNames(REPO);
    for (const e of CATALOG) expect(taken.has(e.name.toUpperCase()), e.name).toBe(true);
  });
});

describe('createIndicator', () => {
  let root: string;
  beforeEach(() => {
    // A copy of the parts of the repo the scaffold reads and writes, inside the web package so Vitest can import the
    // generated module (outside the typechecked folders and gitignored).
    mkdirSync(SCRATCH, { recursive: true });
    root = mkdtempSync(join(SCRATCH, 'repo-'));
    mkdirSync(join(root, TEST_DIR), { recursive: true });
    cpSync(join(REPO, INDICATORS_DIR), join(root, INDICATORS_DIR), { recursive: true });
  });
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it('writes a valid indicator wired to the palette, and its test', async () => {
    const written = createIndicator('ScaffoldProbe', { root });
    expect(written).toEqual([join(CUSTOM_DIR, 'scaffoldProbe.ts'), join(TEST_DIR, 'scaffoldProbe.test.ts')]);

    const source = readFileSync(join(root, written[0]!), 'utf8');
    expect(source).toMatch(/lineSlots: \[0\]/);
    const mod = await import(/* @vite-ignore */ join(root, written[0]!));
    expect(customIndicatorProblem(mod.default)).toBeNull();
    expect(mod.default.catalog).toMatchObject({ name: 'SCAFFOLDPROBE', label: 'Scaffold probe', pane: 'sub', lineSlots: [0] });
    expect(await mod.default.template.calc([1, 2, 3].map((close) => ({ close })), { calcParams: [2] })).toEqual([
      { value: null }, { value: 1.5 }, { value: 2.5 },
    ]);

    expect(readFileSync(join(root, written[1]!), 'utf8')).toBe(testSource(indicatorSpec('ScaffoldProbe')));
  });

  it('puts a price-pane overlay on a slot no other overlay uses by default', async () => {
    const [file] = createIndicator('ScaffoldOverlay', { root, pane: 'main' });
    const mod = await import(/* @vite-ignore */ join(root, file!));
    expect(customIndicatorProblem(mod.default)).toBeNull();
    expect(mod.default.catalog).toMatchObject({ pane: 'main', lineSlots: [4] });
    const shipped = ['MA', 'EMA', 'BOLL', 'SAR', 'BBI', 'VWAP'];
    expect(CATALOG.filter((e) => e.pane === 'main').map((e) => e.name)).toEqual(expect.arrayContaining(shipped));
    const overlaySlots = CATALOG.filter((e) => shipped.includes(e.name)).flatMap((e) => e.lineSlots ?? e.lines.map((_, i) => i));
    expect(overlaySlots).not.toContain(4);
  });

  it('the generated test imports modules that exist', () => {
    const imports = [...testSource(indicatorSpec('Foo')).matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    const testDir = join(REPO, 'apps/web', TEST_DIR.slice('apps/web/'.length));
    for (const spec of imports.filter((s) => !s.endsWith('/custom/foo'))) {
      expect(existsSync(`${resolve(testDir, spec)}.ts`), spec).toBe(true);
    }
    expect(resolve(testDir, '../../src/chart/indicators/custom/foo')).toBe(join(REPO, CUSTOM_DIR, 'foo'));
  });

  it('refuses names already in the picker, case-insensitively', () => {
    expect(() => createIndicator('RSI', { root })).toThrow(/RSI already exists/);
    expect(() => createIndicator('Vwap', { root })).toThrow(/VWAP already exists/);
    expect(() => createIndicator('Wyckoff', { root })).toThrow(/WYCKOFF already exists/);
  });

  it('refuses to overwrite: an existing indicator or test file is left alone and nothing is written', () => {
    createIndicator('ScaffoldFoo', { root });
    const indicatorPath = join(root, CUSTOM_DIR, 'scaffoldFoo.ts');
    writeFileSync(indicatorPath, '// my work\n');
    expect(() => createIndicator('ScaffoldFoo', { root })).toThrow(/already exists/);
    expect(readFileSync(indicatorPath, 'utf8')).toBe('// my work\n');

    const testPath = join(root, TEST_DIR, 'scaffoldBar.test.ts');
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(testPath, '// my test\n');
    expect(() => createIndicator('ScaffoldBar', { root })).toThrow(/scaffoldBar\.test\.ts already exists/);
    expect(existsSync(join(root, CUSTOM_DIR, 'scaffoldBar.ts'))).toBe(false);
    expect(readFileSync(testPath, 'utf8')).toBe('// my test\n');
  });
});

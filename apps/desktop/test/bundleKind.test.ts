import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import asar from '@electron/asar';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { bundleKindProblem, checkPackagedBundle, packagedAsarPath } = require('../build/after-pack.cjs') as {
  bundleKindProblem: (raw: string | null) => string | null;
  checkPackagedBundle: (asarPath: string) => void;
  packagedAsarPath: (o: { appOutDir: string; platform: string; productFilename: string }) => string;
};

/** An app.asar with dist/bundle-kind.json (null = no marker). */
async function archive(kind: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-kind-'));
  const app = join(dir, 'app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'dist', 'main.cjs'), '');
  if (kind !== null) writeFileSync(join(app, 'dist', 'bundle-kind.json'), JSON.stringify({ kind }));
  const out = join(dir, 'app.asar');
  await asar.createPackage(app, out);
  return out;
}

describe('packaging refuses anything but a production bundle (build/after-pack.cjs)', () => {
  it('accepts only {"kind":"prod"}', () => {
    expect(bundleKindProblem('{"kind":"prod"}')).toBeNull();
    for (const raw of ['{"kind":"dev"}', '{"kind":"test-inspectable"}', '{}', 'nope', null]) {
      expect(bundleKindProblem(raw), String(raw)).toMatch(/bundle/);
    }
  });

  it('reads the marker from the packaged app.asar', async () => {
    expect(() => checkPackagedBundle(asarFor.prod)).not.toThrow();
    expect(() => checkPackagedBundle(asarFor.dev)).toThrow(/dev/);
    expect(() => checkPackagedBundle(asarFor.inspectable)).toThrow(/test-inspectable/);
    expect(() => checkPackagedBundle(asarFor.none)).toThrow(/bundle-kind/);
  });

  it('finds app.asar in the macOS bundle and in Windows/Linux resources', () => {
    expect(packagedAsarPath({ appOutDir: '/o', platform: 'darwin', productFilename: 'Chartmate' }))
      .toBe(join('/o', 'Chartmate.app', 'Contents', 'Resources', 'app.asar'));
    expect(packagedAsarPath({ appOutDir: '/o', platform: 'win32', productFilename: 'Chartmate' })).toBe(join('/o', 'resources', 'app.asar'));
  });

  it('bundle.mjs writes the marker for every kind', () => {
    const src = readFileSync(new URL('../scripts/bundle.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/const kind = testInspectable \? 'test-inspectable' : dev \? 'dev' : 'prod';/);
    expect(src).toMatch(/writeFileSync\(`\$\{out\}\/bundle-kind\.json`, JSON\.stringify\(\{ kind \}\)\)/);
  });
});

const asarFor = {
  prod: await archive('prod'),
  dev: await archive('dev'),
  inspectable: await archive('test-inspectable'),
  none: await archive(null),
};

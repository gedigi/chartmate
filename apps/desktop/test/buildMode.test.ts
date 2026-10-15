import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHardened } from '../src/lib/buildMode.js';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('isHardened', () => {
  it('a production bundle is hardened even when Electron reports isPackaged=false (executable renamed to electron)', () => {
    expect(isHardened({ devBundle: false, isPackaged: false })).toBe(true);
    expect(isHardened({ devBundle: false, isPackaged: true })).toBe(true);
  });
  it('only the development bundle, run unpackaged, is unhardened', () => {
    expect(isHardened({ devBundle: true, isPackaged: false })).toBe(false);
    expect(isHardened({ devBundle: true, isPackaged: true })).toBe(true);
  });
});

describe('every hardening decision goes through isHardened (no raw app.isPackaged gate)', () => {
  it('boot.ts computes the flag once from __DEV_BUNDLE__ and app.isPackaged and gates the startup guards on it', () => {
    const boot = src('src/boot.ts');
    expect(boot).toMatch(/export const hardened = isHardened\(\{ devBundle: __DEV_BUNDLE__, isPackaged: app\.isPackaged \}\)/);
    expect(boot).toMatch(/runStartupGuards\(\{\s*hardened,/);
  });
  it('main.ts takes the flag from boot.ts and never gates hardening on app.isPackaged', () => {
    const main = src('src/main.ts');
    expect(main).toMatch(/import \{ hardened \} from '\.\/boot\.js';/);
    expect(main).toMatch(/allowOverride: !hardened \|\| __TEST_INSPECTABLE__/);
    expect(main).toMatch(/secureWebPreferences\(\{ hardened \}\)/);
    expect(main).toMatch(/const hardenOpts = \{ hardened,/);
    expect(main).toMatch(/menuTemplate\(\{\s*isMac, hardened,/);
    // app.isPackaged is still read, but only for things that are not security gates (update availability, dock icon).
    expect(main).not.toMatch(/(?:secureWebPreferences|menuTemplate|runStartupGuards|hardenApp|hardenAllSessions)\(\{[^}]*isPackaged/);
    expect(main).not.toMatch(/allowOverride: !isPackaged/);
  });
  it('bundle.mjs sets __DEV_BUNDLE__ from --dev only (release and TEST-ONLY bundles are production bundles)', () => {
    const bundle = src('scripts/bundle.mjs');
    expect(bundle).toMatch(/__DEV_BUNDLE__: JSON\.stringify\(dev\)/);
  });
});

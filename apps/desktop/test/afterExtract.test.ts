import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { default: afterExtract } = require('../build/after-extract.cjs') as { default: (ctx: { appOutDir: string; electronPlatformName: string }) => Promise<void> };
const { buildConfig } = require('../build/builder-config.cjs') as { buildConfig: (env: Record<string, string>) => any };

let out: string;
beforeEach(() => {
  // What electron-builder extracts from Electron's macOS zip: the app plus its license files next to it.
  out = mkdtempSync(join(tmpdir(), 'after-extract-'));
  mkdirSync(join(out, 'Electron.app', 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(out, 'LICENSE'), 'Copyright (c) Electron contributors');
  writeFileSync(join(out, 'LICENSES.chromium.html'), '<html>Chromium credits</html>');
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe('afterExtract: Electron and Chromium credits ship in the macOS app', () => {
  it('is the configured hook', () => {
    expect(buildConfig({}).afterExtract).toBe('./build/after-extract.cjs');
  });

  it('copies them into Contents/Resources before electron-builder deletes the originals', async () => {
    await afterExtract({ appOutDir: out, electronPlatformName: 'darwin' });
    const res = join(out, 'Electron.app', 'Contents', 'Resources');
    expect(readFileSync(join(res, 'LICENSE.electron.txt'), 'utf8')).toContain('Electron contributors');
    expect(readFileSync(join(res, 'LICENSES.chromium.html'), 'utf8')).toContain('Chromium credits');
  });

  it('fails the build when the distribution lacks them', async () => {
    rmSync(join(out, 'LICENSES.chromium.html'));
    await expect(afterExtract({ appOutDir: out, electronPlatformName: 'darwin' })).rejects.toThrow(/LICENSES\.chromium\.html/);
  });

  it('accepts them already moved into Contents/Resources (electron-builder 26.18 and later do that themselves)', async () => {
    const res = join(out, 'Electron.app', 'Contents', 'Resources');
    renameSync(join(out, 'LICENSE'), join(res, 'LICENSE.electron.txt'));
    renameSync(join(out, 'LICENSES.chromium.html'), join(res, 'LICENSES.chromium.html'));
    await afterExtract({ appOutDir: out, electronPlatformName: 'darwin' });
    expect(readFileSync(join(res, 'LICENSE.electron.txt'), 'utf8')).toContain('Electron contributors');
    expect(readFileSync(join(res, 'LICENSES.chromium.html'), 'utf8')).toContain('Chromium credits');
  });

  it('fails when a file is in neither place', async () => {
    const res = join(out, 'Electron.app', 'Contents', 'Resources');
    renameSync(join(out, 'LICENSE'), join(res, 'LICENSE.electron.txt'));
    rmSync(join(out, 'LICENSES.chromium.html'));
    await expect(afterExtract({ appOutDir: out, electronPlatformName: 'darwin' })).rejects.toThrow(/LICENSES\.chromium\.html/);
  });

  it('leaves Windows alone (electron-builder keeps both files next to the executable there)', async () => {
    await afterExtract({ appOutDir: out, electronPlatformName: 'win32' });
    expect(() => readFileSync(join(out, 'Electron.app', 'Contents', 'Resources', 'LICENSE.electron.txt'))).toThrow();
  });
});

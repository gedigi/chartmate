import { createRequire } from 'node:module';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { FUSES, fuseOptions } = require('../build/fuses.cjs') as {
  FUSES: Record<string, boolean>;
  fuseOptions: () => Record<string | number, unknown>;
};
const builderConfig = require('../electron-builder.config.cjs') as { afterPack: string };

describe('Electron fuses', () => {
  it('flips exactly the required fuses', () => {
    expect(FUSES).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
    });
  });

  it('maps to @electron/fuses V1 options', () => {
    const o = fuseOptions();
    expect(o.version).toBe(FuseVersion.V1);
    expect(o[FuseV1Options.RunAsNode]).toBe(false);
    expect(o[FuseV1Options.EnableCookieEncryption]).toBe(true);
    expect(o[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(o[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(o[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(o[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(o[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]).toBe(false);
    expect(o[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
  });

  it('is applied by the electron-builder afterPack hook', () => {
    expect(builderConfig.afterPack).toMatch(/after-pack\.cjs$/);
    const hook = require('../build/after-pack.cjs') as { default: unknown };
    expect(typeof hook.default).toBe('function');
  });
});

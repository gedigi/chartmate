import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildConfig } = require('../build/builder-config.cjs') as { buildConfig: (env: Record<string, string>) => any };
const product = require('../product.json') as { productName: string; appId: string; executableName: string };

describe('electron-builder config', () => {
  const cfg = buildConfig({});

  it('takes the product identity from product.json', () => {
    expect(cfg.appId).toBe(product.appId);
    expect(cfg.productName).toBe(product.productName);
    expect(cfg.win.executableName).toBe(product.executableName);
    expect(cfg.linux.executableName).toBe(product.executableName);
    expect(cfg.extraMetadata.productName).toBe(product.productName);
  });

  it('ships only the bundle: asar, max compression, en-US only, no maps, no deps, no rebuilds', () => {
    expect(cfg.asar).toBe(true);
    expect(cfg.compression).toBe('maximum');
    expect(cfg.electronLanguages).toEqual(['en', 'en-US']);
    expect(cfg.files).toContain('!dist/**/*.map');
    expect(cfg.extraMetadata.dependencies).toEqual({});
    expect(cfg.npmRebuild).toBe(false);
    expect(cfg.nodeGypRebuild).toBe(false);
  });

  it('uses the Chartmate icons from assets/brand', () => {
    expect(cfg.mac.icon).toBe('../../assets/brand/chartmate.icns');
    expect(cfg.win.icon).toBe('../../assets/brand/chartmate.ico');
    expect(cfg.linux.icon).toBe('../../assets/brand/png/icon-512.png');
    for (const f of [cfg.mac.icon, cfg.win.icon, cfg.linux.icon]) expect(() => readFileSync(new URL(`../${f}`, import.meta.url))).not.toThrow();
  });

  it('builds unsigned and unpublished without secrets', () => {
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.mac.notarize).toBe(false);
    expect(cfg.win.azureSignOptions).toBeUndefined();
    expect(cfg.publish).toBeNull();
  });

  it('signs + notarizes on macOS only when all secrets are present', () => {
    const partial = buildConfig({ CSC_LINK: 'x', APPLE_ID: 'a' });
    expect(partial.mac.identity).toBeUndefined();
    expect(partial.mac.notarize).toBe(false);
    const full = buildConfig({ CSC_LINK: 'x', CSC_KEY_PASSWORD: 'p', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' });
    expect(full.mac.notarize).toBe(true);
  });

  it('uses Azure Trusted Signing on Windows only when configured', () => {
    const env = {
      AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
      AZURE_TRUSTED_SIGNING_ACCOUNT: 'acc', AZURE_TRUSTED_SIGNING_PROFILE: 'prof', AZURE_PUBLISHER_NAME: 'CN=altv',
    };
    expect(buildConfig(env).win.azureSignOptions).toEqual({
      publisherName: 'CN=altv', endpoint: 'https://weu.codesigning.azure.net', codeSigningAccountName: 'acc', certificateProfileName: 'prof',
    });
  });

  it('publishes a draft GitHub release only when asked', () => {
    expect(buildConfig({ ALTV_PUBLISH: 'github' }).publish).toEqual([{ provider: 'github', releaseType: 'draft' }]);
  });

  it('macOS: hardened runtime with minimal entitlements (JIT only)', () => {
    expect(cfg.mac.hardenedRuntime).toBe(true);
    for (const file of [cfg.mac.entitlements, cfg.mac.entitlementsInherit]) {
      const plist = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
      expect(keys, file).toEqual(['com.apple.security.cs.allow-jit']);
    }
  });
});

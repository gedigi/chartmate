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
      AZURE_TRUSTED_SIGNING_ACCOUNT: 'acc', AZURE_TRUSTED_SIGNING_PROFILE: 'prof', AZURE_PUBLISHER_NAME: 'CN=Chartmate',
    };
    expect(buildConfig(env).win.azureSignOptions).toEqual({
      publisherName: 'CN=Chartmate', endpoint: 'https://weu.codesigning.azure.net', codeSigningAccountName: 'acc', certificateProfileName: 'prof',
    });
  });

  it('Certum: signs through build/win-sign.cjs with SHA-256 only, the Certum timestamp and the pinned publisher', () => {
    const win = buildConfig({ CHARTMATE_WIN_PUBLISHER_NAME: ' Open Source Developer, Jane Doe ', CHARTMATE_WIN_CERT_SHA1: 'ab'.repeat(20) }).win;
    expect(win.signtoolOptions.sign).toBe(require('../build/win-sign.cjs').sign);
    expect(win.signtoolOptions.signingHashAlgorithms).toEqual(['sha256']);
    expect(win.signtoolOptions.publisherName).toBe('Open Source Developer, Jane Doe');
    expect(win.signtoolOptions.rfc3161TimeStampServer).toBe('http://time.certum.pl');
    expect(win.azureSignOptions).toBeUndefined();
    // electron-builder must not look the certificate up itself (it cannot on macOS): the hook does.
    expect(win.signtoolOptions.certificateSha1).toBeUndefined();
    expect(win.signtoolOptions.certificateSubjectName).toBeUndefined();
  });

  it('no sign hook without Certum settings (the unsigned build is unchanged)', () => {
    expect(cfg.win.signtoolOptions).toBeUndefined();
    expect(buildConfig({ CHARTMATE_WIN_PUBLISHER_NAME: 'X' }).win.signtoolOptions).toBeUndefined();
  });

  it('GitHub publish settings come from GITHUB_REPOSITORY (never hardcoded) and only when asked', () => {
    expect(buildConfig({ CHARTMATE_PUBLISH: 'github', GITHUB_REPOSITORY: 'someone/somerepo' }).publish)
      .toEqual([{ provider: 'github', owner: 'someone', repo: 'somerepo', releaseType: 'release' }]);
    expect(() => buildConfig({ CHARTMATE_PUBLISH: 'github' })).toThrow(/GITHUB_REPOSITORY/);
    expect(buildConfig({ CHARTMATE_PUBLISH: '', GITHUB_REPOSITORY: 'someone/somerepo' }).publish).toBeNull();
    expect(buildConfig({}).publish).toBeNull();
  });

  it('Windows ships an NSIS installer and a portable zip for x64 and arm64', () => {
    expect(cfg.win.target).toEqual([{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }]);
  });

  it('no repository URL is hardcoded in the build configuration', () => {
    for (const f of ['../build/builder-config.cjs', '../electron-builder.config.cjs', '../package.json', '../product.json']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).not.toMatch(/github\.com\//);
    }
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

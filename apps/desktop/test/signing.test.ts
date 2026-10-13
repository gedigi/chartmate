import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { signingFor, AZURE_KEYS } = require('../build/signing.cjs') as {
  signingFor: (env: Record<string, string>, platform: string) => { signed: boolean; notarize: boolean; azure: boolean; method: string };
  AZURE_KEYS: string[];
};

const azure = Object.fromEntries(AZURE_KEYS.map((k) => [k, 'x']));

describe('signingFor (per platform)', () => {
  it('nothing set → unsigned everywhere', () => {
    for (const p of ['darwin', 'win32', 'linux']) expect(signingFor({}, p)).toMatchObject({ signed: false, method: 'unsigned' });
  });

  it('blank values count as unset', () => {
    expect(signingFor({ CSC_LINK: ' ' }, 'darwin').signed).toBe(false);
    expect(signingFor({ WIN_CSC_LINK: '' }, 'win32').signed).toBe(false);
  });

  it('macOS: CSC_LINK/CSC_NAME sign; notarization needs all three Apple secrets', () => {
    expect(signingFor({ CSC_LINK: 'p12' }, 'darwin')).toMatchObject({ signed: true, notarize: false });
    expect(signingFor({ CSC_NAME: 'Developer ID Application: X' }, 'darwin').signed).toBe(true);
    expect(signingFor({ CSC_LINK: 'p12', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, 'darwin').notarize).toBe(true);
  });

  it('a macOS certificate does not make a Windows build signed, and vice versa', () => {
    expect(signingFor({ CSC_LINK: 'p12' }, 'win32').signed).toBe(false);
    expect(signingFor({ WIN_CSC_LINK: 'pfx' }, 'darwin').signed).toBe(false);
    expect(signingFor(azure, 'darwin').signed).toBe(false);
  });

  it('Windows: Azure Trusted Signing needs every key; a WIN_CSC_LINK certificate also signs', () => {
    expect(signingFor(azure, 'win32')).toMatchObject({ signed: true, azure: true });
    const { AZURE_PUBLISHER_NAME: _drop, ...partial } = azure;
    expect(signingFor(partial, 'win32').signed).toBe(false);
    expect(signingFor({ WIN_CSC_LINK: 'pfx' }, 'win32')).toMatchObject({ signed: true, azure: false });
  });
});

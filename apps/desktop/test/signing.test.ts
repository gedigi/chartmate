import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { signingFor, AZURE_KEYS } = require('../build/signing.cjs') as {
  signingFor: (env: Record<string, string>, platform: string) => { signed: boolean; notarize: boolean; azure: boolean; certum: string | null; method: string };
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

describe('signingFor: Certum (SimplySign)', () => {
  const pub = { CHARTMATE_WIN_PUBLISHER_NAME: 'Open Source Developer, Jane Doe' };
  const thumb = 'ab'.repeat(20);

  it('CI login (username + otpauth URI) signs, as "Certum (SimplySign)"', () => {
    const s = signingFor({ ...pub, CERTUM_USERNAME: 'me@example.com', CERTUM_OTP_URI: 'otpauth://totp/x?secret=ABC' }, 'win32');
    expect(s).toMatchObject({ signed: true, certum: 'ci-login', azure: false, method: 'Certum (SimplySign)' });
  });

  it('a logged-in SimplySign Desktop: thumbprint (Windows) or PKCS#11 module (macOS/Linux)', () => {
    expect(signingFor({ ...pub, CHARTMATE_WIN_CERT_SHA1: thumb }, 'win32')).toMatchObject({ signed: true, certum: 'signtool' });
    expect(signingFor({ ...pub, CHARTMATE_WIN_PKCS11_MODULE: '/usr/local/lib/libSimplySignPKCS.dylib' }, 'win32'))
      .toMatchObject({ signed: true, certum: 'pkcs11' });
  });

  it('the publisher name is required: a Certum credential without it fails instead of building unsigned', () => {
    expect(() => signingFor({ CERTUM_USERNAME: 'me', CERTUM_OTP_URI: 'otpauth://x' }, 'win32')).toThrow(/CHARTMATE_WIN_PUBLISHER_NAME/);
    expect(() => signingFor({ CHARTMATE_WIN_CERT_SHA1: thumb, CHARTMATE_WIN_PUBLISHER_NAME: ' ' }, 'win32')).toThrow(/PUBLISHER_NAME/);
  });

  it('half of the CI login pair fails loudly', () => {
    expect(() => signingFor({ ...pub, CERTUM_USERNAME: 'me' }, 'win32')).toThrow(/CERTUM_USERNAME and CERTUM_OTP_URI/);
    expect(() => signingFor({ ...pub, CERTUM_OTP_URI: 'otpauth://x' }, 'win32')).toThrow(/CERTUM_USERNAME and CERTUM_OTP_URI/);
  });

  it('a publisher name alone (certificate not set up yet) stays unsigned', () => {
    expect(signingFor(pub, 'win32')).toMatchObject({ signed: false, certum: null, method: 'unsigned' });
  });

  it('never applies to macOS; Azure wins when both are configured; Certum wins over a .p12', () => {
    expect(signingFor({ ...pub, CHARTMATE_WIN_CERT_SHA1: thumb }, 'darwin')).toMatchObject({ signed: false, certum: null });
    expect(signingFor({ ...azure, ...pub, CHARTMATE_WIN_CERT_SHA1: thumb }, 'win32')).toMatchObject({ azure: true, certum: null });
    expect(signingFor({ ...pub, CHARTMATE_WIN_CERT_SHA1: thumb, WIN_CSC_LINK: 'pfx' }, 'win32').method).toBe('Certum (SimplySign)');
  });
});

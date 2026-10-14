import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Plan = { command: string; args: string[]; env: Record<string, string> };
type Host = { file: string; out: string; description?: string; hostPlatform: string; hostArch: string; moduleArchs: string[] | null; exists: (p: string) => boolean };
const { signtoolArgs, osslsigncodePlan, isTransient, isPinFailure, resetPinLatch, toolEnv, signFile } = require('../build/win-sign.cjs') as {
  signtoolArgs: (o: { thumbprint?: string; file: string; description?: string }) => string[];
  osslsigncodePlan: (env: Record<string, string>, host: Host) => Plan;
  isTransient: (output: string) => boolean;
  isPinFailure: (output: string) => boolean;
  resetPinLatch: () => void;
  toolEnv: (env: Record<string, string>, extra?: Record<string, string>) => Record<string, string>;
  signFile: (file: string, opts: { env: Record<string, string> }) => Promise<void>;
};

const MODULE = '/usr/local/lib/libSimplySignPKCS.dylib';
const ARM_PROVIDER = '/opt/homebrew/opt/libp11/lib/ossl-modules/pkcs11prov.dylib';
const INTEL_PROVIDER = '/usr/local/opt/libp11/lib/ossl-modules/pkcs11prov.dylib';
const env = { CHARTMATE_WIN_PUBLISHER_NAME: 'Jane Doe', CHARTMATE_WIN_PKCS11_MODULE: MODULE };
const host = (over: Partial<Host> = {}): Host => ({
  file: '/r/Chartmate.exe', out: '/r/.Chartmate.exe.signed', description: 'Chartmate', hostPlatform: 'darwin', hostArch: 'arm64',
  moduleArchs: ['arm64', 'x86_64'], exists: () => true, ...over,
});
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('signtool backend', () => {
  it('selects the certificate by thumbprint, SHA-256 file digest, RFC 3161 Certum timestamp', () => {
    expect(signtoolArgs({ thumbprint: 'ab'.repeat(20), file: 'C:\\r\\a.exe', description: 'Chartmate' })).toEqual([
      'sign', '/sha1', 'AB'.repeat(20), '/fd', 'sha256', '/tr', 'http://time.certum.pl', '/td', 'sha256', '/d', 'Chartmate', '/v', 'C:\\r\\a.exe',
    ]);
  });
  it('rejects a malformed thumbprint', () => {
    expect(() => signtoolArgs({ thumbprint: 'nope', file: 'a.exe' })).toThrow(/thumbprint/);
    expect(() => signtoolArgs({ file: 'a.exe' })).toThrow(/thumbprint/);
  });
});

describe('osslsigncode + PKCS#11 backend', () => {
  it('signs SHA-256 with the Certum timestamp through the PKCS#11 provider and module, into a temp file', () => {
    const p = osslsigncodePlan(env, host());
    expect(p.command).toBe('osslsigncode');
    expect(after(p.args, '-provider')).toBe(ARM_PROVIDER);
    expect(after(p.args, '-pkcs11module')).toBe(MODULE);
    expect(after(p.args, '-pkcs11cert')).toBe('pkcs11:type=cert');
    expect(after(p.args, '-key')).toBe('pkcs11:type=private');
    expect(after(p.args, '-h')).toBe('sha256');
    expect(after(p.args, '-ts')).toBe('http://time.certum.pl');
    expect(after(p.args, '-in')).toBe('/r/Chartmate.exe');
    expect(after(p.args, '-out')).toBe('/r/.Chartmate.exe.signed');
    expect(p.env).toEqual({});
  });

  it('a PIN goes to the PKCS#11 provider through the child environment, never onto the command line', () => {
    const p = osslsigncodePlan({ ...env, CHARTMATE_WIN_PKCS11_PIN: '123456' }, host());
    expect(p.env).toEqual({ PKCS11_PIN: '123456' });
    expect(p.args.join(' ')).not.toContain('123456');
  });

  it('an Intel-only module (SimplySign Desktop for macOS) on Apple silicon runs an x86_64 toolchain under Rosetta', () => {
    const p = osslsigncodePlan(env, host({ moduleArchs: ['x86_64'] }));
    expect(p.command).toBe('/usr/bin/arch');
    expect(p.args.slice(0, 2)).toEqual(['-x86_64', '/usr/local/bin/osslsigncode']);
    expect(after(p.args, '-provider')).toBe(INTEL_PROVIDER);
  });

  it('explicit overrides: tool, provider, object URIs, chain', () => {
    const p = osslsigncodePlan({
      ...env, CHARTMATE_OSSLSIGNCODE: '/opt/x/osslsigncode', CHARTMATE_WIN_PKCS11_PROVIDER: '/p.dylib',
      CHARTMATE_WIN_PKCS11_CERT: 'pkcs11:object=c', CHARTMATE_WIN_PKCS11_KEY: 'pkcs11:object=k', CHARTMATE_WIN_CERT_CHAIN: '/chain.pem',
    }, host());
    expect(p.command).toBe('/opt/x/osslsigncode');
    expect(after(p.args, '-provider')).toBe('/p.dylib');
    expect(after(p.args, '-pkcs11cert')).toBe('pkcs11:object=c');
    expect(after(p.args, '-key')).toBe('pkcs11:object=k');
    expect(after(p.args, '-ac')).toBe('/chain.pem');
  });

  it('fails clearly when the module or the provider is missing', () => {
    expect(() => osslsigncodePlan(env, host({ exists: () => false }))).toThrow(/PKCS#11 module not found/);
    expect(() => osslsigncodePlan(env, host({ exists: (p) => p === MODULE }))).toThrow(/provider not found/);
    expect(() => osslsigncodePlan({ CHARTMATE_WIN_PUBLISHER_NAME: 'x' }, host())).toThrow(/CHARTMATE_WIN_PKCS11_MODULE/);
  });
});

describe('retry policy', () => {
  it('retries timestamp / network hiccups, never PIN or login problems (a card locks after 3 bad PINs)', () => {
    expect(isTransient('SignTool Error: The specified timestamp server either could not be reached')).toBe(true);
    expect(isTransient('Failed to connect to http://time.certum.pl')).toBe(true);
    expect(isTransient('CKR_PIN_INCORRECT')).toBe(false);
    expect(isTransient('timestamp ok but PIN locked')).toBe(false);
    expect(isTransient('No certificates were found that met all the given criteria.')).toBe(false);
    // Not every message that mentions HTTP is a network hiccup.
    expect(isTransient('HTTP 401 Unauthorized')).toBe(false);
    expect(isTransient('see https://example.com for details')).toBe(false);
    expect(isTransient('HTTP error 503')).toBe(true);
  });
  it('recognizes PIN / token login failures', () => {
    for (const m of ['CKR_PIN_INCORRECT', 'CKR_PIN_LOCKED', 'No PIN was entered', 'Login to token failed', 'The PIN is incorrect']) {
      expect(isPinFailure(m), m).toBe(true);
    }
    expect(isPinFailure('Failed to connect to http://time.certum.pl')).toBe(false);
  });
});

describe('signing tools get a minimal environment', () => {
  it('keeps what Windows and a PKCS#11 module need, drops the secrets, adds only what is asked for', () => {
    const e = toolEnv({
      PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/h', CHARTMATE_CERTUM_OTP_URI: 'otpauth://x', CHARTMATE_CERTUM_USERNAME: 'me',
      CHARTMATE_WIN_PKCS11_PIN: '1', AZURE_CLIENT_SECRET: 's', GITHUB_TOKEN: 't', SOFTHSM2_CONF: '/c', CHARTMATE_WIN_SIGN_PASS_ENV: 'SOFTHSM2_CONF',
    }, { PKCS11_PIN: '1' });
    expect(e).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/h', SOFTHSM2_CONF: '/c', PKCS11_PIN: '1' });
  });
});

describe.skipIf(process.platform === 'win32')('PIN latch', () => {
  it('after one rejected PIN no further signing tool is started', async () => {
    resetPinLatch();
    const dir = mkdtempSync(join(tmpdir(), 'chartmate-pin-'));
    const count = join(dir, 'count');
    const tool = join(dir, 'fake-osslsigncode');
    writeFileSync(tool, `#!/bin/sh\necho x >> "${count}"\necho "CKR_PIN_INCORRECT" >&2\nexit 1\n`);
    chmodSync(tool, 0o755);
    for (const f of ['m.so', 'p.so', 'a.exe', 'b.exe']) writeFileSync(join(dir, f), 'x');
    const e = { CHARTMATE_WIN_PUBLISHER_NAME: 'x', CHARTMATE_WIN_PKCS11_MODULE: join(dir, 'm.so'), CHARTMATE_WIN_PKCS11_PROVIDER: join(dir, 'p.so'), CHARTMATE_OSSLSIGNCODE: tool };
    await expect(signFile(join(dir, 'a.exe'), { env: e })).rejects.toThrow(/no further attempts/);
    await expect(signFile(join(dir, 'b.exe'), { env: e })).rejects.toThrow(/refusing further attempts/);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    resetPinLatch();
  });
});

describe('signFile guards', () => {
  it('refuses to run without a Certum configuration, or in CI mode before the login exported a thumbprint', async () => {
    await expect(signFile('/nope.exe', { env: {} })).rejects.toThrow(/not configured/);
    await expect(signFile('/nope.exe', { env: { CHARTMATE_WIN_PUBLISHER_NAME: 'x', CHARTMATE_CERTUM_USERNAME: 'u', CHARTMATE_CERTUM_OTP_URI: 'otpauth://x' } }))
      .rejects.toThrow(/login\.ps1/);
  });
});

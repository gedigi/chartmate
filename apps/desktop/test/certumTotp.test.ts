import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { base32Decode, parseOtp, totp, waitForFreshWindow } from '../scripts/certum/totp.mjs';

const b32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of Buffer.from(s)) bits += c.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g)!.map((b) => alphabet[parseInt(b.padEnd(5, '0'), 2)]).join('');
};

describe('TOTP (RFC 6238 test vectors)', () => {
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1234567890, '89005924', '91819424', '93441116'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const keys = { SHA1: '12345678901234567890', SHA256: '12345678901234567890123456789012', SHA512: '1234567890'.repeat(6) + '1234' };
  it.each(vectors)('t=%s', (t, sha1, sha256, sha512) => {
    for (const [algorithm, expected] of [['SHA1', sha1], ['SHA256', sha256], ['SHA512', sha512]] as const) {
      const p = parseOtp(`otpauth://totp/Certum:me?secret=${b32(keys[algorithm])}&algorithm=${algorithm}&digits=8&period=30`);
      expect(totp(p, t * 1000), algorithm).toBe(expected);
    }
  });
});

describe('otpauth parsing', () => {
  it('defaults to SHA1 / 6 digits / 30 s; a bare base32 seed works; CHARTMATE_CERTUM_TOTP_ALGORITHM overrides', () => {
    const seed = b32('12345678901234567890');
    expect(parseOtp(`otpauth://totp/x?secret=${seed}`)).toMatchObject({ algorithm: 'SHA1', digits: 6, period: 30 });
    expect(parseOtp(seed.toLowerCase())).toMatchObject({ algorithm: 'SHA1', digits: 6 });
    expect(parseOtp(`otpauth://totp/x?secret=${seed}&algorithm=SHA1`, 'SHA-256').algorithm).toBe('SHA256');
    expect(totp(parseOtp(seed), 59_000)).toBe('287082');
  });
  it('rejects junk', () => {
    expect(() => parseOtp('otpauth://hotp/x?secret=AAAA')).toThrow(/totp/);
    expect(() => parseOtp('otpauth://totp/x?secret=AAAA&algorithm=MD5')).toThrow(/algorithm/);
    expect(() => parseOtp('not base32 !')).toThrow(/base32/);
    expect(() => parseOtp('')).toThrow(/empty/);
    expect(() => base32Decode('1')).toThrow();
  });
  it('waits for a fresh period when the current one is nearly over', () => {
    expect(waitForFreshWindow(30, 10_000, 5)).toBe(0);
    expect(waitForFreshWindow(30, 27_000, 5)).toBe(3_250);
  });
});

describe('CI login hands the seed over without the environment', () => {
  it('totp.mjs --stdin reads the URI from stdin, not from the environment', () => {
    const seed = b32('12345678901234567890');
    const before = Date.now();
    const script = fileURLToPath(new URL('../scripts/certum/totp.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--stdin', '--min-remaining=0'], {
      input: `otpauth://totp/x?secret=${seed}\n`, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
    });
    const after = Date.now();
    expect(r.status, r.stderr).toBe(0);
    const p = parseOtp(seed);
    expect([totp(p, before), totp(p, after)]).toContain(r.stdout.trim());
  });

  it('login.ps1 clears both secrets from its process environment before any child process starts', () => {
    const ps = readFileSync(new URL('../scripts/certum/login.ps1', import.meta.url), 'utf8');
    const code = ps.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const clearUser = code.indexOf("SetEnvironmentVariable('CHARTMATE_CERTUM_USERNAME', $null, 'Process')");
    const clearUri = code.indexOf("SetEnvironmentVariable('CHARTMATE_CERTUM_OTP_URI', $null, 'Process')");
    expect(clearUser).toBeGreaterThan(0);
    expect(clearUri).toBeGreaterThan(0);
    const cleared = Math.max(clearUser, clearUri);
    for (const child of ['Invoke-WebRequest', 'msiexec', 'Start-Process', '& node']) {
      expect(code.indexOf(child), child).toBeGreaterThan(cleared);
    }
    // After clearing, the secrets are read only from the locals, and the seed goes to totp.mjs on stdin.
    expect(code.slice(cleared)).not.toMatch(/\$env:CHARTMATE_CERTUM_(USERNAME|OTP_URI)/);
    expect(code).toMatch(/\$certumOtpUri \| & node \$totpScript --stdin/);
  });
});

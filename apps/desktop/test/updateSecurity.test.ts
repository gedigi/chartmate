import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { compareSemver, isNewerVersion, isPrereleaseVersion, parseSemver } from '../src/lib/semver.js';
import { checkDownloadedBundle, plistBundleVersion, readZipEntry } from '../src/lib/updateBundle.js';
import { createWindowsSignatureVerifier, isPinnedPublisherDn, parseDn, subjectMatches } from '../src/lib/winSignature.js';

describe('semver', () => {
  it('parses strict semver only', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', 1] });
    for (const v of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3 ', 1, null]) expect(parseSemver(v)).toBeNull();
  });
  it('orders versions by semver precedence', () => {
    const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0'];
    for (let i = 1; i < sorted.length; i++) expect(compareSemver(sorted[i - 1]!, sorted[i]!), `${sorted[i - 1]} < ${sorted[i]}`).toBe(-1);
    expect(compareSemver('1.0.0+build', '1.0.0')).toBe(0);
  });
  it('isNewerVersion refuses equal, older and invalid versions', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(false);
    expect(isNewerVersion('garbage', '1.0.0')).toBe(false);
  });
  it('isPrereleaseVersion parses rather than looking for a dash', () => {
    expect(isPrereleaseVersion('1.1.0-beta.1')).toBe(true);
    expect(isPrereleaseVersion('1.1.0')).toBe(false);
    expect(isPrereleaseVersion('1.1.0+build-5')).toBe(false); // build metadata is not a pre-release
    expect(isPrereleaseVersion('not-a-version')).toBe(false);
  });
});

/** Minimal zip writer (local headers + central directory + EOCD) for test fixtures. */
function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const plist = (v: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleName</key><string>Chartmate</string>
<key>CFBundleShortVersionString</key>
<string>${v}</string></dict></plist>`);

const write = (b: Buffer) => {
  const f = join(mkdtempSync(join(tmpdir(), 'update-zip-')), 'u.zip');
  writeFileSync(f, b);
  return f;
};

describe('downloaded macOS bundle version (checked before the hand-over to Squirrel.Mac)', () => {
  it('reads Info.plist from the zip (stored or deflated) and parses CFBundleShortVersionString', async () => {
    for (const deflate of [false, true]) {
      const f = write(zip([
        { name: 'Chartmate.app/Contents/Frameworks/x/Info.plist', data: plist('9.9.9') },
        { name: 'Chartmate.app/Contents/Info.plist', data: plist('1.2.0'), deflate },
      ]));
      const entry = await readZipEntry(f, (n) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(n), 1 << 20);
      expect(plistBundleVersion(entry!.toString('utf8'))).toBe('1.2.0');
    }
  });
  it('accepts only a newer version that matches the advertised one', async () => {
    const f = write(zip([{ name: 'Chartmate.app/Contents/Info.plist', data: plist('1.2.0'), deflate: true }]));
    await expect(checkDownloadedBundle(f, { advertised: '1.2.0', current: '1.1.0' })).resolves.toBeUndefined();
    await expect(checkDownloadedBundle(f, { advertised: '1.3.0', current: '1.1.0' })).rejects.toThrow(/does not match/);
    await expect(checkDownloadedBundle(f, { advertised: '1.2.0', current: '1.2.0' })).rejects.toThrow(/not newer/);
    await expect(checkDownloadedBundle(f, { advertised: '1.2.0', current: '1.5.0' })).rejects.toThrow(/not newer/);
  });
  it('fails closed on anything unexpected', async () => {
    const noPlist = write(zip([{ name: 'Chartmate.app/Contents/MacOS/x', data: Buffer.from('x') }]));
    await expect(checkDownloadedBundle(noPlist, { advertised: '1.2.0', current: '1.1.0' })).rejects.toThrow();
    const binary = write(zip([{ name: 'Chartmate.app/Contents/Info.plist', data: Buffer.from('bplist00....') }]));
    await expect(checkDownloadedBundle(binary, { advertised: '1.2.0', current: '1.1.0' })).rejects.toThrow();
    const two = write(zip([
      { name: 'A.app/Contents/Info.plist', data: plist('1.2.0') },
      { name: 'B.app/Contents/Info.plist', data: plist('1.2.0') },
    ]));
    await expect(checkDownloadedBundle(two, { advertised: '1.2.0', current: '1.1.0' })).rejects.toThrow(/one app/);
    await expect(checkDownloadedBundle(write(Buffer.from('not a zip')), { advertised: '1.2.0', current: '1.1.0' })).rejects.toThrow();
    const huge = write(zip([{ name: 'Chartmate.app/Contents/Info.plist', data: Buffer.alloc(2 << 20, 0x20) }]));
    await expect(checkDownloadedBundle(huge, { advertised: '1.2.0', current: '1.1.0' })).rejects.toThrow();
  });
  it('plistBundleVersion rejects non-semver and duplicate keys', () => {
    expect(plistBundleVersion('<key>CFBundleShortVersionString</key><string>1.2</string>')).toBeNull();
    expect(plistBundleVersion('<key>CFBundleShortVersionString</key><string>1.2.0</string><key>CFBundleShortVersionString</key><string>1.3.0</string>')).toBeNull();
  });
});

const DN = 'CN="Open Source Developer, Jane Doe", O=Open Source Developer, L=Szczecin, C=PL';

describe('publisher DN pin', () => {
  it('parses Windows/.NET subjects (quoted values, escapes, repeated attributes)', () => {
    expect(parseDn(DN)).toEqual(new Map([['CN', ['Open Source Developer, Jane Doe']], ['O', ['Open Source Developer']], ['L', ['Szczecin']], ['C', ['PL']]]));
    expect(parseDn('CN=A\\, B, OU=x, OU=y')).toEqual(new Map([['CN', ['A, B']], ['OU', ['x', 'y']]]));
    expect(parseDn('CN="say ""hi"""')!.get('CN')).toEqual(['say "hi"']);
    for (const bad of ['', 'Jane Doe', 'CN=', 'CN="unterminated', '=x']) expect(parseDn(bad)).toBeNull();
  });
  it('a usable pin names CN, O and C', () => {
    expect(isPinnedPublisherDn(DN)).toBe(true);
    expect(isPinnedPublisherDn('CN=Jane Doe')).toBe(false);
    expect(isPinnedPublisherDn('CN=Jane Doe, O=Jane')).toBe(false);
    expect(isPinnedPublisherDn('')).toBe(false);
  });
  it('every pinned attribute must match; a same-CN subject from another organization is refused', () => {
    expect(subjectMatches(DN, DN)).toBe(true);
    expect(subjectMatches(`${DN}, S=Zachodniopomorskie`, DN)).toBe(true); // extra subject fields are fine
    expect(subjectMatches(DN.replace('O=Open Source Developer', 'O=Evil Corp'), DN)).toBe(false);
    expect(subjectMatches('CN="Open Source Developer, Jane Doe", C=PL', DN)).toBe(false); // O missing
    expect(subjectMatches(DN.replace('C=PL', 'C=US'), DN)).toBe(false);
    expect(subjectMatches('garbage', DN)).toBe(false);
  });
});

describe('Windows installer signature verifier (fails closed)', () => {
  const file = 'C:\\Users\\me\\AppData\\Local\\chartmate-updater\\pending\\temp-Chartmate-Setup.exe';
  const ok = { Status: 0, Path: file, Subject: DN };
  const run = (out: { stdout?: string; stderr?: string } | Error, pin = DN) => {
    const exec = vi.fn(async () => {
      if (out instanceof Error) throw out;
      return { stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    });
    const verify = createWindowsSignatureVerifier({ exec, expectedDn: pin, log: () => {} });
    return { result: verify(['Open Source Developer, Jane Doe'], file), exec };
  };

  it('accepts a valid signature from the pinned publisher', async () => {
    const { result, exec } = run({ stdout: JSON.stringify(ok) });
    await expect(result).resolves.toBeNull();
    // No shell; the file path travels in the environment, never inside the command text.
    const [cmd, args, opts] = exec.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; shell?: boolean; timeout: number }];
    expect(cmd).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    expect(args.join(' ')).not.toContain(file);
    expect(opts.env.CHARTMATE_VERIFY_FILE).toBe(file);
    expect(opts.shell).not.toBe(true);
    expect(opts.timeout).toBeGreaterThan(0);
  });
  it('is case-insensitive about the reported path (Windows paths)', async () => {
    await expect(run({ stdout: JSON.stringify({ ...ok, Path: file.toLowerCase() }) }).result).resolves.toBeNull();
  });
  it('refuses on every failure: PowerShell blocked, timeout, stderr, bad JSON, wrong status, path or publisher', async () => {
    const refusals = [
      run(new Error('spawn powershell.exe EACCES')),
      run(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })),
      run({ stdout: JSON.stringify(ok), stderr: 'something went wrong' }),
      run({ stdout: 'not json' }),
      run({ stdout: '' }),
      run({ stdout: JSON.stringify({ ...ok, Status: 1 }) }),
      run({ stdout: JSON.stringify({ ...ok, Status: 'NotSigned' }) }),
      run({ stdout: JSON.stringify({ ...ok, Path: 'C:\\other.exe' }) }),
      run({ stdout: JSON.stringify({ ...ok, Path: undefined }) }),
      run({ stdout: JSON.stringify({ ...ok, Subject: DN.replace('O=Open Source Developer', 'O=Someone Else') }) }),
      run({ stdout: JSON.stringify({ ...ok, Subject: null }) }),
      run({ stdout: JSON.stringify(ok) }, 'CN=Open Source Developer'), // unusable pin (CN only)
      run({ stdout: JSON.stringify(ok) }, ''),
    ];
    for (const r of refusals) {
      const res = await r.result;
      expect(typeof res).toBe('string');
      expect(res!.length).toBeGreaterThan(0);
    }
  });
  it('accepts the string form of the Valid status', async () => {
    await expect(run({ stdout: JSON.stringify({ ...ok, Status: 'Valid' }) }).result).resolves.toBeNull();
  });
});

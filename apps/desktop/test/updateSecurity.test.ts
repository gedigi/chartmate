import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compareSemver, isNewerVersion, isPrereleaseVersion, parseSemver } from '../src/lib/semver.js';
import { type BundleExec, checkDownloadedBundle, DITTO, PLUTIL } from '../src/lib/updateBundle.js';
import { createWindowsSignatureVerifier, isPinnedPublisherDn, parseDn, subjectMatches, VERIFY_SCRIPT } from '../src/lib/winSignature.js';

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

const isMac = process.platform === 'darwin';
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'pipe' });

/** A fake update zip, built the way releases are (ditto -c -k --keepParent): `apps` maps app name → version. */
function appZip(apps: Record<string, string | null>, o: { binary?: boolean; extra?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'update-src-'));
  const src = join(root, 'payload');
  mkdirSync(src);
  for (const [name, version] of Object.entries(apps)) {
    mkdirSync(join(src, name, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(src, name, 'Contents', 'MacOS', 'x'), 'x');
    if (version !== null) {
      const plist = join(src, name, 'Contents', 'Info.plist');
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>Chartmate</string>
<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
      if (o.binary) run('/usr/bin/plutil', ['-convert', 'binary1', plist]);
    }
  }
  if (o.extra) writeFileSync(join(src, o.extra), 'x');
  const zipFile = join(root, 'u.zip');
  const names = Object.keys(apps);
  if (names.length === 1 && !o.extra) run('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(src, names[0]!), zipFile]);
  else run('/usr/bin/ditto', ['-c', '-k', src, zipFile]);
  return zipFile;
}

const tmpRoots: string[] = [];
const privateTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'update-check-'));
  tmpRoots.push(d);
  return d;
};
const leftovers = (d: string) => readdirSync(d);

describe.skipIf(!isMac)('downloaded macOS bundle version (ditto + plutil, before the Squirrel.Mac hand-over)', () => {
  it('accepts only a newer version that matches the advertised one, and cleans up', async () => {
    const zipFile = appZip({ 'Chartmate.app': '1.2.0' });
    const t = privateTmp();
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: t })).resolves.toBeUndefined();
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.3.0', current: '1.1.0', tmpRoot: t })).rejects.toThrow(/does not match/);
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.2.0', tmpRoot: t })).rejects.toThrow(/not newer/);
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.5.0', tmpRoot: t })).rejects.toThrow(/not newer/);
    expect(leftovers(t)).toEqual([]);
  });
  it('reads binary plists too', async () => {
    const zipFile = appZip({ 'Chartmate.app': '1.2.0' }, { binary: true });
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: privateTmp() })).resolves.toBeUndefined();
  });
  it('fails closed: two apps, extra top-level files, no plist, a non-semver version, or not a zip', async () => {
    const t = privateTmp();
    const opts = { advertised: '1.2.0', current: '1.1.0', tmpRoot: t };
    await expect(checkDownloadedBundle(appZip({ 'A.app': '1.2.0', 'B.app': '1.2.0' }), opts)).rejects.toThrow(/exactly one app/);
    await expect(checkDownloadedBundle(appZip({ 'Chartmate.app': '1.2.0' }, { extra: 'README' }), opts)).rejects.toThrow(/exactly one app/);
    await expect(checkDownloadedBundle(appZip({ 'Chartmate.app': null }), opts)).rejects.toThrow();
    await expect(checkDownloadedBundle(appZip({ 'Chartmate.app': '1.2' }), opts)).rejects.toThrow(/no valid version/);
    const notZip = join(privateTmp(), 'x.zip');
    writeFileSync(notZip, 'not a zip');
    await expect(checkDownloadedBundle(notZip, opts)).rejects.toThrow();
    expect(leftovers(t)).toEqual([]);
  });
});

describe('downloaded bundle check: process handling (any platform, fake runner)', () => {
  it('uses ditto and plutil by absolute path, with a timeout and no shell, in a private temp dir', async () => {
    const calls: { cmd: string; args: string[]; opts: { timeout: number; shell?: boolean } }[] = [];
    const t = privateTmp();
    const exec: BundleExec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === DITTO) mkdirSync(join(args[3]!, 'Chartmate.app', 'Contents'), { recursive: true });
      return { stdout: cmd === PLUTIL ? '1.2.0\n' : '', stderr: '' };
    };
    const zipFile = join(t, 'u.zip');
    writeFileSync(zipFile, 'zip');
    await checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: t, exec });
    expect(calls.map((c) => c.cmd)).toEqual(['/usr/bin/ditto', '/usr/bin/plutil']);
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-x', '-k', zipFile]);
    expect(calls[1]!.args).toEqual(['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', expect.stringMatching(/Chartmate\.app\/Contents\/Info\.plist$/)]);
    for (const c of calls) {
      expect(c.opts.timeout).toBeGreaterThan(0);
      expect(c.opts.shell).not.toBe(true);
    }
    const extractDir = calls[0]!.args[3]!;
    if (process.platform !== 'win32') expect(statSafe(extractDir)).toBeNull(); // removed afterwards
    expect(leftovers(t)).toEqual(['u.zip']);
  });
  it('refuses when extraction fails or times out, and still cleans up', async () => {
    const t = privateTmp();
    const zipFile = join(t, 'u.zip');
    writeFileSync(zipFile, 'zip');
    const exec: BundleExec = async (cmd, args) => {
      if (cmd === DITTO) {
        mkdirSync(join(args[3]!, 'partial'), { recursive: true });
        throw Object.assign(new Error('timed out'), { killed: true });
      }
      return { stdout: '1.2.0', stderr: '' };
    };
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: t, exec })).rejects.toThrow(/could not be extracted/);
    expect(leftovers(t)).toEqual(['u.zip']);
  });
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('removes an extracted bundle with read-only directories (555), keeping the result', async () => {
    const t = privateTmp();
    const zipFile = join(t, 'u.zip');
    writeFileSync(zipFile, 'zip');
    const exec: BundleExec = async (cmd, args) => {
      if (cmd === DITTO) {
        const ro = join(args[3]!, 'Chartmate.app', 'Contents', 'Resources');
        mkdirSync(join(ro, 'deep'), { recursive: true });
        writeFileSync(join(ro, 'deep', 'f'), 'x');
        chmodSync(join(ro, 'deep'), 0o555);
        chmodSync(ro, 0o555);
      }
      return { stdout: cmd === PLUTIL ? '1.2.0\n' : '', stderr: '' };
    };
    const log = vi.fn();
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: t, exec, log })).resolves.toBeUndefined();
    expect(leftovers(t)).toEqual(['u.zip']);
    expect(log).not.toHaveBeenCalled();
    // A refusal stays a refusal, and the read-only tree is still removed.
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.3.0', current: '1.1.0', tmpRoot: t, exec, log })).rejects.toThrow(/does not match/);
    expect(leftovers(t)).toEqual(['u.zip']);
  });
  it('a cleanup failure is logged and never replaces the check result', async () => {
    const t = privateTmp();
    const zipFile = join(t, 'u.zip');
    writeFileSync(zipFile, 'zip');
    const exec: BundleExec = async (cmd, args) => {
      if (cmd === DITTO) mkdirSync(join(args[3]!, 'Chartmate.app', 'Contents'), { recursive: true });
      return { stdout: cmd === PLUTIL ? '1.2.0\n' : '', stderr: '' };
    };
    const log = vi.fn();
    const remove = vi.fn(async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.2.0', current: '1.1.0', tmpRoot: t, exec, log, remove })).resolves.toBeUndefined();
    await expect(checkDownloadedBundle(zipFile, { advertised: '1.3.0', current: '1.1.0', tmpRoot: t, exec, log, remove })).rejects.toThrow(/does not match/);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toMatch(/could not remove the update check directory: EACCES/);
  });
  it('refuses an oversized or missing download before extracting', async () => {
    const exec = vi.fn<BundleExec>();
    await expect(checkDownloadedBundle('/nonexistent/u.zip', { advertised: '1.2.0', current: '1.1.0', tmpRoot: privateTmp(), exec })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});

const statSafe = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

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
  const ok = { Status: 0, Path: file, Subject: DN, ProductVersion: '1.2.0' };
  const run = (out: { stdout?: string; stderr?: string } | Error, pin = DN, advertised: string | null = '1.2.0') => {
    const exec = vi.fn(async () => {
      if (out instanceof Error) throw out;
      return { stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    });
    const verify = createWindowsSignatureVerifier({
      exec, expectedDn: pin, log: () => {}, expectedVersion: () => advertised, currentVersion: '1.1.0',
    });
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
      // The installer's own version must be the advertised one and newer than the running app.
      run({ stdout: JSON.stringify({ ...ok, ProductVersion: '1.0.0' }) }),
      run({ stdout: JSON.stringify({ ...ok, ProductVersion: '1.3.0' }) }),
      run({ stdout: JSON.stringify({ ...ok, ProductVersion: null }) }),
      run({ stdout: JSON.stringify({ ...ok, ProductVersion: '1.1.0' }) }, DN, '1.1.0'),
      run({ stdout: JSON.stringify(ok) }, DN, null),
      // A CLIXML error record on stderr still refuses.
      run({ stdout: JSON.stringify(ok), stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">boom</S></Objs>' }),
    ];
    for (const r of refusals) {
      const res = await r.result;
      expect(typeof res).toBe('string');
      expect(res!.length).toBeGreaterThan(0);
    }
  });
  it('tolerates a stderr that only carries CLIXML progress records', async () => {
    const progress = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>';
    await expect(run({ stdout: JSON.stringify(ok), stderr: progress }).result).resolves.toBeNull();
  });
  it('the PowerShell script silences progress, stops on errors, emits ASCII-only JSON and reads the installer version', () => {
    expect(VERIFY_SCRIPT.startsWith("$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'")).toBe(true);
    expect(VERIFY_SCRIPT).not.toMatch(/OutputEncoding/);
    expect(VERIFY_SCRIPT).toContain('(Get-Item -LiteralPath $env:CHARTMATE_VERIFY_FILE).VersionInfo.ProductVersion');
    expect(VERIFY_SCRIPT).toMatch(/\[\^\\x00-\\x7F\]/);
  });
  it('accepts the string form of the Valid status', async () => {
    await expect(run({ stdout: JSON.stringify({ ...ok, Status: 'Valid' }) }).result).resolves.toBeNull();
  });
});

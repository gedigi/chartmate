import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM script without types
import * as verifyScript from '../scripts/verify-win-signatures.mjs';
// @ts-expect-error plain ESM script without types
import { buildAffectingIgnored, builderEnv, rewriteReleaseNotes, sourceRefEnv, stopChild, takePin, taskkillPath, windowsAssets, withSignalCleanup, writePinFile } from '../scripts/sign-win-release.mjs';

const {
  appUpdateProblems, commonName, latestYmlProblems, latestYmlTextProblems, parseOsslVerify, parseSigntoolVerify, signatureProblems, signLogProblems, zipExtractCommand,
} = verifyScript;

describe('verify-win-signatures', () => {
  it('reads the CN from both DN orders, with commas in the name', () => {
    expect(commonName('O=Test,CN=Chartmate Test Signer')).toBe('Chartmate Test Signer');
    expect(commonName('CN="Open Source Developer, Jane Doe", L=Roma, C=IT')).toBe('Open Source Developer, Jane Doe');
    expect(commonName('C=IT,L=Roma,CN=Open Source Developer\\, Jane Doe')).toBe('Open Source Developer, Jane Doe');
    expect(commonName('O=No CN')).toBeNull();
  });

  const good = [
    'Message digest algorithm  : SHA256',
    "Signer's certificate:", '\tSigner #0:', '\t\tSubject: O=Test,CN=Chartmate Test Signer', '\t\tIssuer : O=Test,CN=Chartmate Test Signer',
    'Countersignatures:', '\tTimestamp time: Oct 14 12:23:54 2026 GMT',
    'Signature verification: ok', 'Number of verified signatures: 1', 'Succeeded',
  ].join('\n');

  it('parses osslsigncode verify output', () => {
    expect(parseOsslVerify(good, 0)).toEqual({ ok: true, cn: 'Chartmate Test Signer', timestamped: true, sha256: true });
    expect(parseOsslVerify(good.replace('Signature verification: ok', 'Signature verification: failed'), 1).ok).toBe(false);
    expect(parseOsslVerify('No signature found\nFailed', 1)).toMatchObject({ ok: false, cn: null, timestamped: false });
  });

  it('flags invalid, wrong-publisher, untimestamped and non-SHA-256 signatures', () => {
    const sig = { ok: true, cn: 'A', timestamped: true, sha256: true };
    expect(signatureProblems('x.exe', sig, 'A')).toEqual([]);
    expect(signatureProblems('x.exe', { ...sig, sha256: undefined }, 'A')).toEqual([]); // Windows: not reported
    expect(signatureProblems('x.exe', { ok: false, cn: 'B', timestamped: false, sha256: false }, 'A')).toHaveLength(4);
  });

  it('a latest.yml that does not parse is reported as such', () => {
    const files = { 'C-win.exe': { size: 1, sha512: 'a' } };
    for (const text of ['', '# nothing\n', 'files: [unclosed']) {
      expect(latestYmlTextProblems(text, files, Object.keys(files)), JSON.stringify(text)).toEqual([expect.stringMatching(/^latest\.yml is not valid YAML \(.+\)$/)]);
    }
    expect(latestYmlTextProblems('path: C-win.exe\nsha512: a\nfiles:\n  - url: C-win.exe\n    size: 1\n    sha512: a\n', files, Object.keys(files))).toEqual([]);
  });

  it('latest.yml must describe exactly the signed installers on disk', () => {
    const files = { 'C-win.exe': { size: 1, sha512: 'a' }, 'C-win-x64.exe': { size: 2, sha512: 'b' } };
    const latest = { path: 'C-win.exe', sha512: 'a', files: [{ url: 'C-win.exe', size: 1, sha512: 'a' }, { url: 'C-win-x64.exe', size: 2, sha512: 'b' }] };
    expect(latestYmlProblems(latest, files, Object.keys(files))).toEqual([]);
    // Pre-signing hashes (the file changed after latest.yml was written) are caught.
    expect(latestYmlProblems({ ...latest, files: [latest.files[0], { url: 'C-win-x64.exe', size: 2, sha512: 'stale' }] }, files, Object.keys(files)))
      .toEqual(['latest.yml: C-win-x64.exe size/sha512 do not match the file']);
    expect(latestYmlProblems({ ...latest, files: [latest.files[0]] }, files, Object.keys(files))).toEqual(['latest.yml: C-win-x64.exe is missing']);
    expect(latestYmlProblems({ ...latest, sha512: 'x' }, files, Object.keys(files))).toEqual(['latest.yml: path/sha512 do not match a listed file']);
  });

  it('the sign log must show each installer, its uninstaller and each app executable', () => {
    const line = (file: string) => JSON.stringify({ file, backend: 'pkcs11' });
    const log = [
      line('/r/win-unpacked/chartmate.exe'), line('/r/win-arm64-unpacked/chartmate.exe'),
      line('/r/C-1.0.0-win.__uninstaller.exe'), line('/r/C-1.0.0-win.exe'),
    ];
    const exes = ['win-unpacked/chartmate.exe', 'win-arm64-unpacked/chartmate.exe'];
    expect(signLogProblems(log, ['C-1.0.0-win.exe'], exes)).toEqual([]);
    expect(signLogProblems(log.slice(0, 2).concat(log[3]!), ['C-1.0.0-win.exe'], exes)).toEqual(['sign log: the uninstaller of C-1.0.0-win.exe was not signed']);
    expect(signLogProblems([line('C:\\r\\win-unpacked\\chartmate.exe')], [], ['win-unpacked/chartmate.exe'])).toEqual([]);
    expect(signLogProblems([], [], ['win-unpacked/chartmate.exe'])).toEqual(['sign log: win-unpacked/chartmate.exe was not signed by the hook']);
  });
});

describe('verify-win-signatures: tools and updater config', () => {
  it('extracts zip entries with the system bsdtar on Windows (full path) and macOS, unzip on Linux', () => {
    expect(zipExtractCommand('win32', { SystemRoot: 'C:\\Windows' }, 'a.zip', 'chartmate.exe'))
      .toEqual({ command: join('C:\\Windows', 'System32', 'tar.exe'), args: ['-xOf', 'a.zip', 'chartmate.exe'] });
    expect(zipExtractCommand('darwin', {}, 'a.zip', 'x')).toEqual({ command: '/usr/bin/tar', args: ['-xOf', 'a.zip', 'x'] });
    expect(zipExtractCommand('linux', {}, 'a.zip', 'x')).toEqual({ command: 'unzip', args: ['-p', 'a.zip', 'x'] });
  });

  it('parses signtool verify /pa /v', () => {
    const out = 'Hash of file (sha256): ABC\nThe signature is timestamped: Mon Oct 14\nSuccessfully verified: a.exe';
    expect(parseSigntoolVerify(out, 0)).toEqual({ ok: true, timestamped: true, sha256: true });
    expect(parseSigntoolVerify('Hash of file (sha1): ABC\nSuccessfully verified: a.exe', 0)).toEqual({ ok: true, timestamped: false, sha256: false });
    expect(parseSigntoolVerify('SignTool Error: No signature found.', 1).ok).toBe(false);
  });

  it('app-update.yml must pin the publisher', () => {
    expect(appUpdateProblems('win-unpacked', 'provider: github\npublisherName:\n  - Jane Doe\n', 'Jane Doe')).toEqual([]);
    expect(appUpdateProblems('win-unpacked', 'provider: github\npublisherName: Jane Doe\n', 'Jane Doe')).toEqual([]);
    expect(appUpdateProblems('win-unpacked', 'provider: github\n', 'Jane Doe')).toHaveLength(1);
    expect(appUpdateProblems('win-unpacked', 'publisherName:\n  - Someone\n', 'Jane Doe')).toHaveLength(1);
    // An empty or comment-only file is a reported problem, not a crash.
    expect(appUpdateProblems('win-unpacked', '', 'Jane Doe')).toHaveLength(1);
    expect(appUpdateProblems('win-unpacked', '# nothing\n', 'Jane Doe')).toHaveLength(1);
    expect(appUpdateProblems('win-unpacked', null, 'Jane Doe')).toHaveLength(1);
  });
});

describe('sign-win-release', () => {
  it('uploads only the Windows release files', () => {
    expect(windowsAssets([
      'Chartmate-1.0.0-win.exe', 'Chartmate-1.0.0-win.exe.blockmap', 'Chartmate-1.0.0-win-x64.exe', 'Chartmate-1.0.0-win-x64.zip',
      'latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml', 'win-unpacked', 'Chartmate-1.0.0-mac-arm64.zip', 'latest-mac.yml',
    ])).toEqual(['Chartmate-1.0.0-win-x64.exe', 'Chartmate-1.0.0-win-x64.zip', 'Chartmate-1.0.0-win.exe', 'Chartmate-1.0.0-win.exe.blockmap', 'latest.yml']);
  });

  const notes = (mac: string) => [
    '## Chartmate 1.0.0', '', '| Platform | Code signing |', '|---|---|', `| macOS (arm64, x64) | ${mac} |`, '| Windows (x64, arm64) | unsigned |', '',
    '**Windows build is unsigned.** SmartScreen warns on first launch: choose **More info**, then **Run anyway**.', '',
    'Unsigned builds contain no auto-updater: install new versions manually from this page.', '', 'Chartmate is licensed under the AGPL-3.0.', '',
  ].join('\n');

  it('rewrites the Windows row and drops the warnings that no longer apply', () => {
    const out = rewriteReleaseNotes(notes('Developer ID + notarized'), 'Certum (SimplySign)');
    expect(out).toContain('| Windows (x64, arm64) | Certum (SimplySign) |');
    expect(out).toContain('| macOS (arm64, x64) | Developer ID + notarized |');
    expect(out).not.toMatch(/unsigned/i);
    expect(out).toContain('Chartmate is licensed under the AGPL-3.0.');
  });

  it('drops the "signing failed in CI" note once the signed build is uploaded', () => {
    const failed = notes('Developer ID + notarized').replace('**Windows build is unsigned.**',
      '**Windows signing step failed in CI** — sign with `sign:win`.\n\n**Windows build is unsigned.**');
    const out = rewriteReleaseNotes(failed, 'Certum (SimplySign)');
    expect(out).not.toMatch(/signing (step )?failed/);
    expect(out).not.toMatch(/unsigned/i);
  });

  it('refuses ignored files that would change the build (.env files), not the example or node_modules', () => {
    expect(buildAffectingIgnored(['.env', 'apps/server/.env.local', '.env.example', 'node_modules/x/.env', 'apps/desktop/dist/main.cjs', '']))
      .toEqual(['.env', 'apps/server/.env.local']);
  });

  it('keeps the no-updater line while macOS is still unsigned', () => {
    const out = rewriteReleaseNotes(notes('unsigned'), 'Certum (SimplySign)');
    expect(out).not.toContain('Windows build is unsigned');
    expect(out).toContain('Unsigned builds contain no auto-updater');
  });
});

describe('sign:win web build: the About dialog\'s source ref', () => {
  const HEAD = '0123456789abcdef0123456789abcdef01234567';

  it('publishing (HEAD checked to be the tag): the tag, as a build of that tag in CI', () => {
    expect(sourceRefEnv({ PATH: '/bin' }, { upload: true, tag: 'v1.2.3', head: HEAD }))
      .toEqual({ PATH: '/bin', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: HEAD });
  });

  it('--no-upload (any commit): only the commit, whatever ref variables the shell had', () => {
    expect(sourceRefEnv({ PATH: '/bin', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: 'stale' }, { upload: false, tag: 'v1.2.3', head: HEAD }))
      .toEqual({ PATH: '/bin', GITHUB_SHA: HEAD });
  });
});

describe('sign:win PIN hand-off', () => {
  it('electron-builder and its children never get the PIN in their environment, only the path of a private file', () => {
    const env = builderEnv({ PATH: '/bin', CHARTMATE_WIN_PKCS11_PIN: '123456' }, '/private/x/pin');
    expect(env).toEqual({ PATH: '/bin', CHARTMATE_WIN_PKCS11_PIN_FILE: '/private/x/pin' });
    expect(JSON.stringify(env)).not.toContain('123456');
    expect(builderEnv({ PATH: '/bin', CHARTMATE_WIN_PKCS11_PIN_FILE: '/stale' }, null)).toEqual({ PATH: '/bin' });
  });

  it('takes the PIN out of the process environment first, so pnpm, git and gh never inherit it', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin', CHARTMATE_WIN_PKCS11_PIN: '123456' };
    expect(takePin(env)).toBe('123456');
    expect(env).toEqual({ PATH: '/bin' });
    expect(takePin(env)).toBeUndefined();
  });

  /** A stand-in for the electron-builder child: `exit()` makes it end, as a real child does after a signal. */
  const fakeChild = (pid = 777) => {
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => true),
      exit(signal: string) {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      },
    });
    return child;
  };
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const handlerCount = (p: EventEmitter) => ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].reduce((n, e) => n + p.listenerCount(e), 0);

  it('the parent exiting any other way (process.exit, an uncaught error): kills the builder\'s group, removes the PIN file', async () => {
    const proc = fakeProc();
    const child = fakeChild();
    const cleanup = vi.fn();
    const reapGroup = vi.fn();
    void withSignalCleanup(cleanup, (track: (c: unknown) => void) => {
      track(child);
      return new Promise<void>(() => {});
    }, proc, { stopChild: vi.fn(), reapGroup });
    await Promise.resolve();
    proc.emit('exit', 1);
    expect(reapGroup).toHaveBeenCalledWith(child);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('once electron-builder ends normally, its group is killed too (no grandchild lingers) and nothing is left armed', async () => {
    const proc = fakeProc();
    const child = fakeChild();
    const cleanup = vi.fn();
    const reapGroup = vi.fn();
    await withSignalCleanup(cleanup, async (track: (c: unknown) => void) => { track(child); }, proc, { reapGroup });
    expect(reapGroup).toHaveBeenCalledWith(child);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(handlerCount(proc)).toBe(0);
    proc.emit('exit', 0);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('taskkill is run from System32 by absolute path, never looked up on PATH', () => {
    expect(taskkillPath({ SystemRoot: 'D:\\Win' })).toBe(win32.join('D:\\Win', 'System32', 'taskkill.exe'));
    expect(taskkillPath({})).toBe(win32.join('C:\\Windows', 'System32', 'taskkill.exe'));
  });

  it('SIGINT / SIGTERM before electron-builder starts: removes the PIN file, then re-raises the signal', async () => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const proc = fakeProc();
      const cleanup = vi.fn();
      void withSignalCleanup(cleanup, () => new Promise<void>(() => {}), proc);
      await Promise.resolve();
      proc.emit(sig);
      await tick();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalledWith(4242, sig);
      expect(handlerCount(proc)).toBe(0);
    }
  });

  it('SIGINT / SIGTERM while electron-builder runs: forwards it, waits for the child to exit, then cleans up and re-raises', async () => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const proc = fakeProc();
      const child = fakeChild();
      const cleanup = vi.fn();
      const stop = vi.fn((c: ReturnType<typeof fakeChild>) => new Promise<void>((r) => { c.once('exit', () => r()); }));
      let settled = false;
      void withSignalCleanup(cleanup, (track: (c: unknown) => void) => {
        track(child);
        return new Promise<void>((_, reject) => { child.once('exit', () => reject(new Error('electron-builder failed (SIGTERM)'))); });
      }, proc, { stopChild: stop, reapGroup: vi.fn() }).finally(() => { settled = true; });
      await Promise.resolve();
      proc.emit(sig);
      await tick();
      expect(stop).toHaveBeenCalledWith(child, sig);
      // The child still runs (it may hold the PIN in memory): nothing is cleaned up or re-raised yet.
      expect(cleanup).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
      // A second Ctrl-C while waiting is absorbed: the parent does not die before the child is gone.
      proc.emit(sig);
      expect(proc.listenerCount(sig)).toBe(1);
      child.exit(sig);
      await tick();
      await tick();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalledWith(4242, sig);
      expect(handlerCount(proc)).toBe(0);
      // The step's own failure never reaches the caller (which would exit 1 and race the re-raised signal).
      expect(settled).toBe(false);
    }
  });

  it('stopChild (POSIX): signals the child\'s process group, then SIGKILLs it after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(777);
      const killGroup = vi.fn();
      let stopped = false;
      const done = stopChild(child, 'SIGTERM', { platform: 'darwin', killGroup, timeoutMs: 5000 }).then(() => { stopped = true; });
      expect(killGroup).toHaveBeenCalledWith(777, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(4999);
      expect(stopped).toBe(false);
      expect(killGroup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(killGroup).toHaveBeenLastCalledWith(777, 'SIGKILL');
      child.exit('SIGKILL');
      await done;
      expect(stopped).toBe(true);
      // Once the leader has exited, the group is SIGKILLed again, so no grandchild lingers.
      expect(killGroup).toHaveBeenCalledTimes(3);
      expect(killGroup).toHaveBeenLastCalledWith(777, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopChild (POSIX): falls back to the child alone without a process group; nothing to do once it has exited', async () => {
    const child = fakeChild();
    const killGroup = vi.fn(() => { throw new Error('ESRCH'); });
    const done = stopChild(child, 'SIGINT', { platform: 'linux', killGroup, timeoutMs: 5000 });
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.exit('SIGINT');
    await done; // the group SIGKILL after exit fails too (ESRCH): ignored
    expect(killGroup).toHaveBeenCalledTimes(2);

    const gone = fakeChild();
    gone.exitCode = 0;
    await stopChild(gone, 'SIGINT', { platform: 'linux', killGroup });
    expect(gone.kill).not.toHaveBeenCalled();
    expect(killGroup).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform !== 'win32')('stopChild: a real child group that ignores SIGTERM is SIGKILLed after the timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    await stopChild(child, 'SIGTERM', { timeoutMs: 300 });
    expect(child.signalCode).toBe('SIGKILL');
  });

  it.runIf(process.platform !== 'win32')('stopChild: a real grandchild that outlives its parent is killed with the group', async () => {
    // The leader exits on SIGTERM; its child ignores SIGTERM and would otherwise keep running.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'console.log(g.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((r) => child.stdout!.once('data', (d) => r(Number(String(d).trim()))));
    await new Promise((r) => setTimeout(r, 200));
    await stopChild(child, 'SIGTERM', { timeoutMs: 5000 });
    expect(child.signalCode).toBe('SIGTERM');
    const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50)); // reaped by init
    expect(alive()).toBe(false);
  });

  it('stopChild (Windows): kills the whole tree with taskkill /T, or the child alone if taskkill fails', async () => {
    const child = fakeChild(31337);
    const taskkill = vi.fn(() => true);
    const done = stopChild(child, 'SIGINT', { platform: 'win32', taskkill, timeoutMs: 5000 });
    expect(taskkill).toHaveBeenCalledWith(31337);
    expect(child.kill).not.toHaveBeenCalled();
    child.exit('SIGTERM');
    await done;

    const other = fakeChild();
    const done2 = stopChild(other, 'SIGTERM', { platform: 'win32', taskkill: vi.fn(() => false), timeoutMs: 5000 });
    expect(other.kill).toHaveBeenCalledWith('SIGTERM');
    other.exit('SIGTERM');
    await done2;
  });

  it('without a signal: cleanup runs once the step ends (success or failure) and no handler is left', async () => {
    const proc = Object.assign(new EventEmitter(), { pid: 1, kill: vi.fn() });
    const cleanup = vi.fn();
    await withSignalCleanup(cleanup, async () => {}, proc);
    await expect(withSignalCleanup(cleanup, async () => { throw new Error('builder failed'); }, proc)).rejects.toThrow('builder failed');
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(handlerCount(proc)).toBe(0);
  });

  it.runIf(process.platform !== 'win32')('writes the PIN to an owner-only file in a fresh owner-only directory, removed by cleanup', () => {
    const { file, cleanup } = writePinFile('424242');
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('424242');
    cleanup();
    expect(existsSync(dirname(file))).toBe(false);
  });
});

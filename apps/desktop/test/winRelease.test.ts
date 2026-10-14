import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import {
  appUpdateProblems, commonName, latestYmlProblems, parseOsslVerify, parseSigntoolVerify, signatureProblems, signLogProblems, zipExtractCommand,
} from '../scripts/verify-win-signatures.mjs';
// @ts-expect-error plain ESM script without types
import { rewriteReleaseNotes, windowsAssets } from '../scripts/sign-win-release.mjs';

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

  it('keeps the no-updater line while macOS is still unsigned', () => {
    const out = rewriteReleaseNotes(notes('unsigned'), 'Certum (SimplySign)');
    expect(out).not.toContain('Windows build is unsigned');
    expect(out).toContain('Unsigned builds contain no auto-updater');
  });
});

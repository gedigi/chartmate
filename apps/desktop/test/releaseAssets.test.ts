import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import * as assets from '../../../scripts/check-release-assets.mjs';

const { checkReleaseAssets, expectedAssets, parseUpdateInfo } = assets as {
  checkReleaseAssets: (dir: string, version: string) => string[];
  expectedAssets: (v: string) => { required: string[] };
  parseUpdateInfo: (t: string) => { version: string | null; files: { url: string; sha512?: string; size?: number }[] };
};

const V = '1.2.0';
let dir: string;
const sha = (s: string) => createHash('sha512').update(s).digest('base64');
const yml = (files: string[]) => [
  `version: ${V}`, 'files:',
  ...files.flatMap((f) => [`  - url: ${f}`, `    sha512: ${sha(f)}`, `    size: ${f.length}`]),
  `path: ${files[0]}`, `sha512: ${sha(files[0]!)}`, "releaseDate: '2026-10-15T10:00:00.000Z'", '',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
  // Each file's content is its own name, so the listed sha512 and size match.
  for (const f of expectedAssets(V).required) writeFileSync(join(dir, f), f);
  writeFileSync(join(dir, 'latest-mac.yml'), yml([`Chartmate-${V}-mac-x64.zip`, `Chartmate-${V}-mac-arm64.zip`]));
  writeFileSync(join(dir, 'latest.yml'), yml([`Chartmate-${V}-win.exe`]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('release asset check', () => {
  it('accepts the complete set whose update metadata matches the files', () => {
    expect(checkReleaseAssets(dir, V)).toEqual([]);
  });

  it('reports a missing or an unexpected file', () => {
    rmSync(join(dir, `Chartmate-${V}-mac-arm64.dmg`));
    writeFileSync(join(dir, 'evil.pkg'), 'x');
    expect(checkReleaseAssets(dir, V)).toEqual([`missing: Chartmate-${V}-mac-arm64.dmg`, 'unexpected: evil.pkg']);
  });

  it('reports update metadata that does not match its download', () => {
    writeFileSync(join(dir, `Chartmate-${V}-win.exe`), 'tampered');
    expect(checkReleaseAssets(dir, V)).toEqual([
      `latest.yml: sha512 of Chartmate-${V}-win.exe does not match the file`,
      `latest.yml: size of Chartmate-${V}-win.exe does not match the file`,
    ]);
  });

  it('reports a version mismatch and files the metadata names but the release lacks', () => {
    writeFileSync(join(dir, 'latest.yml'), yml(['Chartmate-9.9.9-win.exe']).replace(`version: ${V}`, 'version: 9.9.9'));
    expect(checkReleaseAssets(dir, V)).toEqual([
      `latest.yml: version 9.9.9, expected ${V}`,
      'latest.yml: lists Chartmate-9.9.9-win.exe, which is not in the release',
    ]);
  });

  it('expects what v1.0.0 shipped, for the new version', () => {
    expect(expectedAssets('1.0.0').required.sort()).toEqual([
      'Chartmate-1.0.0-mac-arm64.dmg', 'Chartmate-1.0.0-mac-arm64.zip', 'Chartmate-1.0.0-mac-arm64.zip.blockmap',
      'Chartmate-1.0.0-mac-x64.dmg', 'Chartmate-1.0.0-mac-x64.zip', 'Chartmate-1.0.0-mac-x64.zip.blockmap',
      'Chartmate-1.0.0-win-arm64.exe', 'Chartmate-1.0.0-win-arm64.exe.blockmap', 'Chartmate-1.0.0-win-arm64.zip',
      'Chartmate-1.0.0-win-x64.exe', 'Chartmate-1.0.0-win-x64.exe.blockmap', 'Chartmate-1.0.0-win-x64.zip',
      'Chartmate-1.0.0-win.exe', 'Chartmate-1.0.0-win.exe.blockmap', 'latest-mac.yml', 'latest.yml',
    ]);
  });

  it('parses the layout electron-builder writes', () => {
    expect(parseUpdateInfo(yml(['a.zip', 'b.zip']))).toEqual({
      version: V,
      files: [{ url: 'a.zip', sha512: sha('a.zip'), size: 5 }, { url: 'b.zip', sha512: sha('b.zip'), size: 5 }],
    });
  });
});

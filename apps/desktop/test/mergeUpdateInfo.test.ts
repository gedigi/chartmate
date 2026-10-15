import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { mergeUpdateInfo } from '../scripts/merge-update-info.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(s: string): any };

const x64 = `version: 1.2.0
files:
  - url: Chartmate-1.2.0-mac-x64.zip
    sha512: aaa
    size: 100
path: Chartmate-1.2.0-mac-x64.zip
sha512: aaa
releaseDate: '2026-10-15T10:00:00.000Z'
`;
const arm64 = `version: 1.2.0
files:
  - url: Chartmate-1.2.0-mac-arm64.zip
    sha512: bbb
    size: 90
path: Chartmate-1.2.0-mac-arm64.zip
sha512: bbb
releaseDate: '2026-10-15T10:05:00.000Z'
`;

describe('merging per-arch latest-mac.yml files (prepackaged builds)', () => {
  it('lists both zips, x64 first, with the legacy path/sha512 on the first zip', () => {
    for (const order of [[x64, arm64], [arm64, x64]]) {
      const merged = yaml.load(mergeUpdateInfo(order));
      expect(merged.version).toBe('1.2.0');
      expect(merged.files.map((f: { url: string }) => f.url)).toEqual(['Chartmate-1.2.0-mac-x64.zip', 'Chartmate-1.2.0-mac-arm64.zip']);
      expect(merged.files[1]).toEqual({ url: 'Chartmate-1.2.0-mac-arm64.zip', sha512: 'bbb', size: 90 });
      expect(merged.path).toBe('Chartmate-1.2.0-mac-x64.zip');
      expect(merged.sha512).toBe('aaa');
      expect(typeof merged.releaseDate).toBe('string');
    }
  });

  it('refuses mismatched versions, duplicates and empty inputs', () => {
    expect(() => mergeUpdateInfo([x64, arm64.replace(/1\.2\.0/g, '1.2.1')])).toThrow(/version mismatch/);
    expect(() => mergeUpdateInfo([x64, x64])).toThrow(/listed twice/);
    expect(() => mergeUpdateInfo([x64, 'version: 1.2.0\nfiles: []\n'])).toThrow(/no files/);
    expect(() => mergeUpdateInfo([])).toThrow(/nothing/);
  });
});

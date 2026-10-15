import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import * as releaseTags from '../../../scripts/release-tags.mjs';

const { parseTag, compareTags, floatingTags, latestRelease } = releaseTags as {
  parseTag: (t: string) => unknown;
  compareTags: (a: string, b: string) => number;
  floatingTags: (tag: string, tags: string[]) => { latest: boolean; minor: boolean; major: boolean };
  latestRelease: (tags: string[]) => string | null;
};

describe('release tag ranking (which floating names a release may move)', () => {
  it('parses only vMAJOR.MINOR.PATCH[-PRE]', () => {
    expect(parseTag('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseTag('v1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', '1'] });
    for (const bad of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-', 'v1.2.3+build', 'vX', 'latest']) expect(parseTag(bad), bad).toBeNull();
  });

  it('orders by SemVer precedence, numerically, with pre-releases below their release', () => {
    const sorted = ['v1.10.0', 'v1.2.0', 'v1.2.0-rc.1', 'v1.2.0-beta.11', 'v1.2.0-beta.2', 'v1.2.0-beta', 'v0.9.9', 'v2.0.0-alpha']
      .sort(compareTags);
    expect(sorted).toEqual(['v0.9.9', 'v1.2.0-beta', 'v1.2.0-beta.2', 'v1.2.0-beta.11', 'v1.2.0-rc.1', 'v1.2.0', 'v1.10.0', 'v2.0.0-alpha']);
    expect(compareTags('v1.0.0-1', 'v1.0.0-alpha')).toBeLessThan(0); // numeric identifiers rank below alphanumeric ones
  });

  it('the newest release moves latest, X.Y and X', () => {
    expect(floatingTags('v1.3.0', ['v1.0.0', 'v1.2.5', 'v1.3.0'])).toEqual({ latest: true, minor: true, major: true });
    expect(floatingTags('v1.0.0', [])).toEqual({ latest: true, minor: true, major: true });
  });

  it('a backport moves only the names it still leads', () => {
    const tags = ['v1.2.4', 'v1.3.0', 'v2.0.0', 'v1.2.5'];
    expect(floatingTags('v1.2.5', tags)).toEqual({ latest: false, minor: true, major: false });
    expect(floatingTags('v1.3.1', tags)).toEqual({ latest: false, minor: true, major: true });
    expect(floatingTags('v1.2.3', tags)).toEqual({ latest: false, minor: false, major: false });
  });

  it('pre-releases never move a floating name, and never block one', () => {
    expect(floatingTags('v3.0.0-beta.1', ['v2.0.0'])).toEqual({ latest: false, minor: false, major: false });
    expect(floatingTags('v2.1.0', ['v2.0.0', 'v3.0.0-beta.1', 'v2.1.1-rc.1'])).toEqual({ latest: true, minor: true, major: true });
  });

  it('ignores names that are not release tags and rejects a bad tag', () => {
    expect(floatingTags('v1.0.0', ['v9', 'nightly', 'v1.0.0'])).toEqual({ latest: true, minor: true, major: true });
    expect(() => floatingTags('1.0.0', [])).toThrow(/not a release tag/);
  });

  it('CLI: reads the tag list on stdin and prints GITHUB_OUTPUT lines', () => {
    const script = fileURLToPath(new URL('../../../scripts/release-tags.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, 'v1.2.5'], { input: 'v1.2.4\nv1.3.0\nv1.2.5\n', encoding: 'utf8' });
    expect(out).toBe('latest=false\nminor=true\nmajor=false\n');
  });

  it('the latest full release: the highest vX.Y.Z, never a pre-release or another name', () => {
    expect(latestRelease(['v1.2.5', 'v1.10.0', 'v1.9.9', 'v2.0.0-beta.1', 'nightly', 'v3'])).toBe('v1.10.0');
    expect(latestRelease(['v1.0.0-rc.1'])).toBeNull();
    expect(latestRelease([])).toBeNull();
  });

  it('CLI --latest: prints the latest full release, and fails when there is none', () => {
    const script = fileURLToPath(new URL('../../../scripts/release-tags.mjs', import.meta.url));
    expect(execFileSync(process.execPath, [script, '--latest'], { input: 'v0.1.0\nv1.0.0\nv1.1.0-beta.1\n', encoding: 'utf8' })).toBe('v1.0.0\n');
    expect(() => execFileSync(process.execPath, [script, '--latest'], { input: 'v1.0.0-beta.1\n', encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});

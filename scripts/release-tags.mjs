#!/usr/bin/env node
// Which floating names a release tag may move: `latest` (GitHub's Latest release, the image's :latest), the image's
// :X.Y and :X. A tag moves one only when no other full release outranks it there, so a backport (v1.2.5 after
// v1.3.0) never pulls `latest` or :1 backward. Pre-releases (vX.Y.Z-suffix) move none.
//
//   git tag --list 'v*' | node scripts/release-tags.mjs vX.Y.Z    # prints latest=…, minor=…, major=… (true/false)
//
// Pure semver over the tag names (SemVer 2.0.0 precedence); names that are not vMAJOR.MINOR.PATCH[-PRE] are ignored.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** @returns {{ major: number, minor: number, patch: number, pre: string[] } | null} */
export function parseTag(tag) {
  const m = TAG.exec(String(tag).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** SemVer precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareTags(a, b) {
  const x = typeof a === 'string' ? parseTag(a) : a;
  const y = typeof b === 'string' ? parseTag(b) : b;
  if (!x || !y) throw new Error(`not a release tag: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length; // a release outranks its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @param {string} tag the tag being released
 * @param {string[]} tags every existing tag (the tag itself may or may not be among them)
 * @returns {{ latest: boolean, minor: boolean, major: boolean }}
 */
export function floatingTags(tag, tags) {
  const self = parseTag(tag);
  if (!self) throw new Error(`not a release tag: ${tag}`);
  if (self.pre.length > 0) return { latest: false, minor: false, major: false };
  const higher = tags.map(parseTag).filter((t) => t && t.pre.length === 0 && compareTags(t, self) > 0);
  return {
    latest: higher.length === 0,
    major: !higher.some((t) => t.major === self.major),
    minor: !higher.some((t) => t.major === self.major && t.minor === self.minor),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag || !parseTag(tag)) {
    console.error('usage: git tag --list "v*" | node scripts/release-tags.mjs vX.Y.Z[-pre]');
    process.exitCode = 2;
  } else {
    const r = floatingTags(tag, readFileSync(0, 'utf8').split('\n').filter(Boolean));
    process.stdout.write(`latest=${r.latest}\nminor=${r.minor}\nmajor=${r.major}\n`);
  }
}

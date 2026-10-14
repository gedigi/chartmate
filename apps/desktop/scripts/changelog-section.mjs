#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (its body, without the heading), for the release notes that
// desktop.yml's release job writes. Usage: node changelog-section.mjs <CHANGELOG.md> <version|vX.Y.Z>
// Prints nothing (and a warning on stderr) when the version has no section; it never fails the release.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of `version`'s section ("## [1.0.0] - 2026-10-14" or "## 1.0.0") up to the next "## " heading, trimmed,
 * without trailing link reference definitions ("[1.0.0]: …"); null when missing or empty.
 * @param {string} text
 * @param {string} version
 * @returns {string | null}
 */
export function changelogSection(text, version) {
  const v = escape(version.replace(/^v/, ''));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${v}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s/.test(l)).join('\n').trim();
  return body === '' ? null : body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) {
    console.error('usage: changelog-section.mjs <CHANGELOG.md> <version>');
    process.exit(2);
  }
  const body = changelogSection(readFileSync(file, 'utf8'), version);
  if (body === null) console.error(`changelog-section: no section for ${version} in ${file}`);
  else process.stdout.write(`${body}\n`);
}

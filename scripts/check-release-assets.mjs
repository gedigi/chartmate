#!/usr/bin/env node
// Checks the files the release job is about to attach to a GitHub Release: exactly the expected set for the version
// (nothing missing, nothing extra), and every file latest-mac.yml / latest.yml lists present with the SHA-512 and
// size it states, so electron-updater never sees metadata that does not match its download.
//
//   node scripts/check-release-assets.mjs <dir> <version>
//
// No dependencies: the update files are read line by line (electron-builder writes a fixed, simple layout).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** File names the release must carry (the set v1.0.0 shipped), nothing more. */
export function expectedAssets(version) {
  const v = version;
  return {
    required: [
      `Chartmate-${v}-mac-x64.dmg`, `Chartmate-${v}-mac-arm64.dmg`,
      `Chartmate-${v}-mac-x64.zip`, `Chartmate-${v}-mac-arm64.zip`,
      `Chartmate-${v}-mac-x64.zip.blockmap`, `Chartmate-${v}-mac-arm64.zip.blockmap`, 'latest-mac.yml',
      // The NSIS installer for both architectures, the per-architecture installers, their blockmaps, the zips.
      `Chartmate-${v}-win.exe`, `Chartmate-${v}-win.exe.blockmap`,
      `Chartmate-${v}-win-x64.exe`, `Chartmate-${v}-win-x64.exe.blockmap`,
      `Chartmate-${v}-win-arm64.exe`, `Chartmate-${v}-win-arm64.exe.blockmap`,
      `Chartmate-${v}-win-x64.zip`, `Chartmate-${v}-win-arm64.zip`, 'latest.yml',
    ],
  };
}

/** The `files:` entries (url, sha512, size) and the version of an electron-builder update file. */
export function parseUpdateInfo(text) {
  const files = [];
  let version = null;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^version:\s*'?([^'\s]+)'?\s*$/.exec(line))) version = m[1];
    else if ((m = /^ {2}- url:\s*(\S+)\s*$/.exec(line))) files.push((current = { url: m[1] }));
    else if (current && (m = /^ {4}sha512:\s*(\S+)\s*$/.exec(line))) current.sha512 = m[1];
    else if (current && (m = /^ {4}size:\s*(\d+)\s*$/.exec(line))) current.size = Number(m[1]);
    else if (!/^ {4}/.test(line)) current = null;
  }
  return { version, files };
}

/** Problems with the release directory (empty = fine). */
export function checkReleaseAssets(dir, version) {
  const problems = [];
  const present = readdirSync(dir).sort();
  const { required } = expectedAssets(version);
  for (const f of required) if (!present.includes(f)) problems.push(`missing: ${f}`);
  for (const f of present) if (!required.includes(f)) problems.push(`unexpected: ${f}`);
  for (const yml of ['latest-mac.yml', 'latest.yml']) {
    if (!present.includes(yml)) continue;
    const info = parseUpdateInfo(readFileSync(join(dir, yml), 'utf8'));
    if (info.version !== version) problems.push(`${yml}: version ${info.version}, expected ${version}`);
    if (info.files.length === 0) problems.push(`${yml}: lists no files`);
    for (const f of info.files) {
      if (!present.includes(f.url)) {
        problems.push(`${yml}: lists ${f.url}, which is not in the release`);
        continue;
      }
      const data = readFileSync(join(dir, f.url));
      const sha512 = createHash('sha512').update(data).digest('base64');
      if (f.sha512 !== sha512) problems.push(`${yml}: sha512 of ${f.url} does not match the file`);
      if (f.size !== undefined && f.size !== statSync(join(dir, f.url)).size) {
        problems.push(`${yml}: size of ${f.url} does not match the file`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error('usage: node scripts/check-release-assets.mjs <dir> <version>');
    process.exitCode = 2;
  } else {
    const problems = checkReleaseAssets(dir, version);
    for (const p of problems) console.log(`::error title=Release assets::${p}`);
    if (problems.length === 0) console.log(`release assets for ${version}: complete, update metadata matches`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

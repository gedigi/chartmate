// Merges the per-architecture latest-mac.yml files of two `electron-builder --prepackaged` runs (one per arch: a
// prepackaged build takes a single .app) into the one file electron-updater reads, the way a single multi-arch run
// writes it: every file listed, zips first, x64 before arm64, and the legacy top-level path/sha512 naming the first
// zip.
//
//   node scripts/merge-update-info.mjs <x64.yml> <arm64.yml> > release/latest-mac.yml
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const rank = (url) => (url.endsWith('.zip') ? 0 : 100) + (/arm64/.test(url) ? 1 : 0);

/** @param {string[]} texts the YAML documents, in architecture order */
export function mergeUpdateInfo(texts) {
  if (texts.length === 0) throw new Error('nothing to merge');
  const infos = texts.map((t) => yaml.load(t));
  const version = infos[0].version;
  const files = [];
  for (const info of infos) {
    if (info.version !== version) throw new Error(`version mismatch: ${version} vs ${info.version}`);
    if (!Array.isArray(info.files) || info.files.length === 0) throw new Error('an update info file lists no files');
    for (const f of info.files) {
      if (typeof f.url !== 'string' || typeof f.sha512 !== 'string') throw new Error('a file entry has no url or sha512');
      if (files.some((g) => g.url === f.url)) throw new Error(`listed twice: ${f.url}`);
      files.push(f);
    }
  }
  files.sort((a, b) => rank(a.url) - rank(b.url));
  const first = files[0];
  return yaml.dump({ version, files, path: first.url, sha512: first.sha512, releaseDate: infos[0].releaseDate }, { lineWidth: -1, noRefs: true });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length < 2) {
    console.error('usage: node scripts/merge-update-info.mjs <latest-mac.yml> <latest-mac.yml> [...]');
    process.exitCode = 2;
  } else {
    process.stdout.write(mergeUpdateInfo(paths.map((p) => readFileSync(p, 'utf8'))));
  }
}

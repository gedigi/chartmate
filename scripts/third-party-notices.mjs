#!/usr/bin/env node
// Third-party license notices for what Chartmate ships, and the license gate for its runtime dependencies.
//
//   node scripts/third-party-notices.mjs --profile=<server|desktop> [--out=<file>] [--check]
//
// Walks the installed production dependency graph (node_modules, no network, no dependencies of its own) from the
// packages that end up in the artifact:
//   server   the Docker image: the server's runtime dependencies plus everything the web UI bundles.
//   desktop  the desktop app: the server code (without better-sqlite3 and pg, which the desktop bundle never
//            contains), the web UI, and the desktop main process's own runtime packages (Electron, electron-updater,
//            kysely, undici, js-yaml).
// For every third-party package it writes the full text of its LICENSE / LICENCE / COPYING / NOTICE files into one
// THIRD_PARTY_NOTICES.txt. It exits 1, naming the packages, when a package's declared license is not on the
// allowlist of AGPL-3.0-compatible licenses below, when it declares no license, or when it ships no license text.
// --check verifies without writing anything.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** SPDX ids whose terms are compatible with distributing the combined work under AGPL-3.0-only. */
export const ALLOWED_LICENSES = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'MPL-2.0',
  'Python-2.0', 'Unlicense', 'Zlib',
]);

/**
 * Runtime roots per artifact: [workspace package dir, dependency names or 'dependencies' for all of them].
 * `exclude`: never walked (not in that artifact). `leaves`: listed, but their own dependencies are not shipped (the
 * electron package's dependencies only download the Electron binary at install time).
 */
export const PROFILES = {
  server: { roots: [['apps/server', 'dependencies'], ['apps/web', 'dependencies']], exclude: [], leaves: [] },
  desktop: {
    roots: [['apps/server', 'dependencies'], ['apps/web', 'dependencies'], ['apps/desktop', ['electron', 'electron-updater', 'kysely', 'undici', 'js-yaml']]],
    exclude: ['better-sqlite3', 'pg'],
    leaves: ['electron'],
  },
};

/** Standard texts for the two short permissive licenses, for packages that declare one but ship no license file. */
const TEMPLATES = {
  MIT: (holder) => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: (holder) => `ISC License\n\nCopyright (c) ${holder}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

/** The package's author as a copyright holder ('the package authors' when it names none). */
const holderOf = (pkg) => {
  const a = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return typeof a === 'string' && a.trim() ? a.replace(/\s*[<(].*$/, '').trim() : `the ${pkg.name} authors`;
};

/**
 * The license texts to reproduce for a package: its LICENSE / NOTICE files, or, for an MIT or ISC package that ships
 * none, the standard text naming the author from its package.json. Empty when there is nothing to reproduce.
 * @param {{ dir: string, license: string, pkg: any }} p
 * @returns {{ title: string, text: string }[]}
 */
export function licenseTexts(p) {
  const files = licenseFiles(p.dir).map((f) => ({ title: f, text: readFileSync(join(p.dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
  if (files.length > 0) return files;
  const template = TEMPLATES[p.license];
  return template ? [{ title: `${p.license} (standard text; the package ships no license file)`, text: template(holderOf(p.pkg)) }] : [];
}

/**
 * Whether an SPDX license expression is acceptable: every AND term allowed, at least one OR alternative allowed.
 * `WITH` exceptions only add permissions, so the base license decides. Anything unparsable is refused.
 * @param {unknown} expression
 */
export function licenseAllowed(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== 'string' || expression.trim() === '') return false;
  const tokens = expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  let i = 0;
  const fail = () => { throw new Error('bad expression'); };
  const primary = () => {
    const t = tokens[i++];
    if (t === undefined) fail();
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') fail();
      return v;
    }
    if (/^(AND|OR|WITH|\))$/i.test(t)) fail();
    let ok = allowed.has(t.replace(/\+$/, ''));
    if (tokens[i]?.toUpperCase() === 'WITH') {
      i += 1;
      if (tokens[i++] === undefined) fail();
    }
    return ok;
  };
  const and = () => {
    let v = primary();
    while (tokens[i]?.toUpperCase() === 'AND') { i += 1; v = primary() && v; }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i]?.toUpperCase() === 'OR') { i += 1; v = and() || v; }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

/** The declared license of a package.json (SPDX `license`, or the legacy `licenses` array, read as OR). */
export function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string');
    if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  return '';
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

/** License and notice files at a package's root (LICENSE first, NOTICE last). */
export function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b));
}

/** Node's lookup: `<dir>/node_modules/<name>`, then each ancestor's (pnpm puts a package's dependencies next to it). */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Third-party packages reachable through `dependencies` / `optionalDependencies` (installed ones only) from the
 * profile's roots. Workspace packages are walked through but not listed (they are Chartmate itself).
 * @returns {{ name: string, version: string, license: string, dir: string, pkg: any }[]}
 */
export function collect(profileName, repo = REPO) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile: ${profileName} (one of ${Object.keys(PROFILES).join(', ')})`);
  const exclude = new Set(profile.exclude);
  const leaves = new Set(profile.leaves);
  const seen = new Set();
  const found = new Map();
  const isWorkspace = (dir) => !dir.split(sep).includes('node_modules') && dir.startsWith(realpathSync(repo) + sep);

  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = readJson(join(dir, 'package.json'));
    if (!isWorkspace(dir)) found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: declaredLicense(pkg), dir, pkg });
    if (leaves.has(pkg.name)) return;
    const deps = { ...(pkg.optionalDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    for (const name of Object.keys(deps).sort()) {
      if (exclude.has(name)) continue;
      const child = resolvePackage(name, dir);
      if (child) visit(child);
      // An optional dependency for another platform is simply not installed; a regular one must be.
      else if (!(name in (pkg.optionalDependencies ?? {}))) throw new Error(`${pkg.name}: dependency ${name} is not installed`);
    }
  };

  for (const [rootDir, which] of profile.roots) {
    const dir = realpathSync(join(repo, rootDir));
    const pkg = readJson(join(dir, 'package.json'));
    const names = which === 'dependencies' ? Object.keys(pkg.dependencies ?? {}) : which;
    seen.add(dir);
    for (const name of [...names].sort()) {
      if (exclude.has(name)) continue;
      const child = resolvePackage(name, dir);
      if (!child) throw new Error(`${pkg.name}: ${name} is not installed (run pnpm install)`);
      visit(child);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Problems that must fail the build: a disallowed or missing license, or no license text to reproduce. */
export function problems(packages) {
  const out = [];
  for (const p of packages) {
    if (!p.license) out.push(`${p.name}@${p.version}: declares no license`);
    else if (!licenseAllowed(p.license)) out.push(`${p.name}@${p.version}: license "${p.license}" is not on the AGPL-3.0-compatible allowlist`);
    if (licenseTexts(p).length === 0) out.push(`${p.name}@${p.version}: ships no LICENSE/NOTICE file to reproduce`);
  }
  return out;
}

/** The THIRD_PARTY_NOTICES.txt text (deterministic: sorted, no dates, no local paths). */
export function render(profileName, packages) {
  const rule = '='.repeat(78);
  const lines = [
    'Chartmate third-party notices',
    '',
    'Chartmate is licensed under the GNU Affero General Public License, version 3 only (see LICENSE).',
    `This ${profileName === 'desktop' ? 'desktop app' : 'server image'} also contains the following third-party software, under`,
    'the licenses reproduced below.',
    '',
    ...packages.map((p) => `  ${p.name} ${p.version} (${p.license})`),
    '',
  ];
  for (const p of packages) {
    lines.push(rule, `${p.name} ${p.version}`, `License: ${p.license}`, rule, '');
    for (const { title, text } of licenseTexts(p)) lines.push(`--- ${title} ---`, '', text, '');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const profile = arg('profile');
  const out = arg('out');
  const check = argv.includes('--check');
  if (!profile || (!out && !check)) {
    console.error('usage: node scripts/third-party-notices.mjs --profile=<server|desktop> (--out=<file> | --check)');
    return 2;
  }
  const packages = collect(profile);
  const bad = problems(packages);
  if (bad.length > 0) {
    console.error(`third-party notices (${profile}): ${bad.length} problem(s):\n  ${bad.join('\n  ')}`);
    return 1;
  }
  if (out) {
    writeFileSync(resolve(out), render(profile, packages));
    console.log(`third-party notices (${profile}): ${packages.length} packages -> ${out}`);
  } else {
    console.log(`third-party notices (${profile}): ${packages.length} packages, all licenses allowed`);
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

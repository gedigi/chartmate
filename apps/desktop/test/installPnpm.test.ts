// .github/scripts/install-pnpm.sh, run for real under bash with npm and corepack stubbed on PATH (no network). The
// script works from the repository it sits in, so each test copies it into a scratch "repository" with its own
// package.json and pnpm-lock.yaml; the tarballs `npm pack` returns are built here, so their hashes are known.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/install-pnpm.sh', import.meta.url));
const REAL = readFileSync(SCRIPT, 'utf8');
const PNPM = '12.11.2';
const target = `${process.platform}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const nativeName = process.platform === 'win32' ? 'pnpm-native.exe' : 'pnpm-native';

let dir: string;
let repo: string;
let bin: string;
let packs: string;
let home: string;
let log: string;

const integrity = (file: string) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

/** A .tgz with package/<name> = content; returns its path. */
function tarball(name: string, files: Record<string, string>): string {
  const src = join(dir, `src-${name}`);
  mkdirSync(join(src, 'package'), { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(src, 'package', f)), { recursive: true });
    writeFileSync(join(src, 'package', f), c);
  }
  const out = join(packs, `${name}.tgz`);
  expect(spawnSync('tar', ['-czf', out, '-C', src, 'package']).status).toBe(0);
  return out;
}

function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/**
 * dist/corepack.js of the fake corepack tarball. The script runs it with node (it is never put on PATH): it records
 * the call, `enable pnpm --install-directory <dir>` writes a pnpm shim there that reports the pinned version, and
 * `install` unpacks the pnpm wrapper into the corepack home as the real one does (STUB_SHADOW: plus a directory
 * where the wrapper would find a platform package before pnpm-native).
 */
const COREPACK_JS = `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'corepack ' + args.join(' ') + '\\n');
if (args[0] === 'enable') {
  const d = args[args.indexOf('--install-directory') + 1];
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'pnpm'), '#!/bin/sh\\necho ${PNPM}\\n', { mode: 0o755 });
}
if (args[0] === 'install') {
  const d = path.join(process.env.COREPACK_HOME, 'v1', 'pnpm', '${PNPM}');
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"pnpm","version":"${PNPM}"}');
  fs.writeFileSync(path.join(d, 'bin', 'pnpm.mjs'), '');
  if (process.env.STUB_SHADOW) fs.mkdirSync(path.join(d, process.env.STUB_SHADOW), { recursive: true });
}
`;
const corepackTarball = () => tarball('corepack', { 'package.json': '{}', 'dist/corepack.js': COREPACK_JS });

/** The scratch repository: the script (corepack pin replaced by `corepackIntegrity`), package.json, lockfile. */
function setUp({ corepackIntegrity, exeIntegrity }: { corepackIntegrity: string; exeIntegrity: string }) {
  mkdirSync(join(repo, '.github', 'scripts'), { recursive: true });
  writeFileSync(join(repo, '.github', 'scripts', 'install-pnpm.sh'), REAL.replace(/^corepack_integrity=.*$/m, `corepack_integrity=${corepackIntegrity}`));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ packageManager: `pnpm@${PNPM}+sha512.${'a'.repeat(128)}` }));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: ${PNPM}
        version: ${PNPM}

packages:

  '@pnpm/exe.${target}@${PNPM}':
    resolution: {integrity: ${exeIntegrity}}
    cpu: [x]
    os: [y]

  '@pnpm/exe.other-target@${PNPM}':
    resolution: {integrity: sha512-${'B'.repeat(86)}==}
`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-pnpm-'));
  repo = join(dir, 'repo');
  bin = join(dir, 'bin');
  packs = join(dir, 'packs');
  home = join(dir, 'corepack-home');
  log = join(dir, 'calls.log');
  for (const d of [repo, bin, packs]) mkdirSync(d);
  // npm pack copies the prepared tarball for the requested spec; npm install only records the call.
  stub('npm', `if [ "$1" = pack ]; then
  for a in "$@"; do case "$a" in --pack-destination=*) dest="\${a#--pack-destination=}" ;; esac; done
  case "$2" in corepack@*) f=corepack.tgz ;; @pnpm/exe.*) f=exe.tgz ;; *) exit 1 ;; esac
  cp "${packs}/$f" "$dest/$f" && echo "$f"
fi
exit 0`);
  // GNU tar (Git Bash on Windows) reads "D:" in an archive name as a remote host, so tar must only ever get
  // relative names: an absolute or drive-letter argument fails here as it would there.
  stub('tar', `for a in "$@"; do case "$a" in /*|[A-Za-z]:*) echo "tar: absolute path $a" >&2; exit 2 ;; esac; done
exec ${spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim()} "$@"`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(repo, '.github', 'scripts', 'install-pnpm.sh')], {
    encoding: 'utf8',
    cwd: dir,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: dir, HOME: dir, COREPACK_HOME: home, STUB_LOG: log, ...extra },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}
const native = () => join(home, 'v1', 'pnpm', PNPM, nativeName);

describe('install-pnpm.sh', () => {
  it('pins corepack by exact version and sha512', () => {
    expect(REAL).toMatch(/^corepack_version=\d+\.\d+\.\d+$/m);
    expect(REAL).toMatch(/^corepack_integrity=sha512-[A-Za-z0-9+/]{86}==$/m);
  });

  it('installs corepack and puts the hash-checked native pnpm binary where the wrapper looks first', () => {
    const corepack = corepackTarball();
    const exe = tarball('exe', { [exeName]: 'native pnpm' });
    setUp({ corepackIntegrity: integrity(corepack), exeIntegrity: integrity(exe) });
    const r = run({ GITHUB_PATH: join(dir, 'github-path') });
    expect(r.out).not.toMatch(/unbound|error/i);
    expect(r.status).toBe(0);
    expect(r.calls).toContainEqual(expect.stringMatching(new RegExp(`^npm pack @pnpm/exe\\.${target}@${PNPM} --pack-destination=\\S+ --silent$`)));
    // Nothing is installed into npm's global prefix (a runner's preinstalled yarn.cmd broke that on Windows).
    expect(r.calls.filter((c) => c.startsWith('npm install'))).toHaveLength(0);
    expect(r.calls).toContainEqual(expect.stringMatching(/^corepack enable pnpm --install-directory \S+\/bin$/));
    expect(r.calls).toContain('corepack install');
    // The shims directory is checked by a PATH lookup and the pinned version, and handed to later steps.
    expect(r.out).toContain(`pnpm ${PNPM}: `);
    const githubPath = readFileSync(join(dir, 'github-path'), 'utf8').trim();
    expect(githubPath).toMatch(/pnpm-toolchain\.[^/]+\/bin$/);
    expect(existsSync(join(githubPath, 'pnpm'))).toBe(true);
    expect(readFileSync(native(), 'utf8')).toBe('native pnpm');
    // tar only ever sees relative names (it runs inside the temporary directory).
    const tars = r.calls.filter((c) => c.startsWith('tar '));
    expect(tars).toEqual(['tar -xzf corepack.tgz package', `tar -xzf exe.tgz package/${exeName}`]);
  });

  it.each([
    ['next to the corepack home (`v1/pnpm/@pnpm`)', '../@pnpm/exe.x'],
    ['inside the wrapper (`node_modules`)', 'node_modules/@pnpm/exe.x'],
  ])('fails closed when the wrapper would find a platform package %s before pnpm-native', (_where, shadow) => {
    const corepack = corepackTarball();
    const exe = tarball('exe', { [exeName]: 'native pnpm' });
    setUp({ corepackIntegrity: integrity(corepack), exeIntegrity: integrity(exe) });
    const r = run({ STUB_SHADOW: shadow });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('would run a platform package from');
    expect(existsSync(native())).toBe(false);
  });

  it('refuses a corepack tarball that does not match the pinned sha512 and installs nothing', () => {
    corepackTarball();
    const exe = tarball('exe', { [exeName]: 'native pnpm' });
    setUp({ corepackIntegrity: `sha512-${'A'.repeat(86)}==`, exeIntegrity: integrity(exe) });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('corepack@0.36.0 does not match the pinned sha512');
    expect(r.calls.some((c) => c.startsWith('npm install') || c.startsWith('corepack'))).toBe(false);
    expect(existsSync(native())).toBe(false);
  });

  it('refuses a native pnpm binary that does not match pnpm-lock.yaml and installs no binary', () => {
    const corepack = corepackTarball();
    tarball('exe', { [exeName]: 'tampered' });
    setUp({ corepackIntegrity: integrity(corepack), exeIntegrity: `sha512-${'C'.repeat(86)}==` });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain(`@pnpm/exe.${target}@${PNPM} does not match the pinned sha512`);
    expect(existsSync(native())).toBe(false);
  });

  it('fails when pnpm-lock.yaml has no entry for the native binary of this platform', () => {
    const corepack = corepackTarball();
    tarball('exe', { [exeName]: 'native pnpm' });
    setUp({ corepackIntegrity: integrity(corepack), exeIntegrity: 'x' });
    writeFileSync(join(repo, 'pnpm-lock.yaml'), readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8').replace(`@pnpm/exe.${target}@`, '@pnpm/exe.renamed@'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain(`pnpm-lock.yaml has no integrity for @pnpm/exe.${target}@${PNPM}`);
    expect(existsSync(native())).toBe(false);
  });

  it('the repository lockfile pins the native binary of every CI runner platform', () => {
    const lock = readFileSync(fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)), 'utf8');
    const pm = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')).packageManager as string;
    const version = /^pnpm@([^+]+)\+/.exec(pm)![1];
    for (const t of ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) {
      expect(lock, t).toMatch(new RegExp(`'@pnpm/exe\\.${t}@${version!.replace(/\./g, '\\.')}':\\n    resolution: \\{integrity: sha512-`));
    }
  });
});

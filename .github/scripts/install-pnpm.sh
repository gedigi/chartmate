#!/usr/bin/env bash
# Installs corepack and pnpm for the workflows' "pnpm (corepack)" step, with every downloaded byte hash-checked
# before it is installed or run. No install script runs. Fails closed.
#
# Usage: install-pnpm.sh [<dir>]
#   Everything goes into a private directory: <dir> (new or empty; the Docker build uses /opt/pnpm), else a fresh
#   one under $RUNNER_TEMP (CI) or the system temp directory. Nothing is written to npm's global prefix, so files a
#   runner preinstalled there (yarn, yarn.cmd, another corepack) are never touched. <dir>/bin holds only the pnpm
#   and pnpx shims; it is put first on PATH for the check below and, in GitHub Actions, appended to $GITHUB_PATH so
#   every later step runs this pnpm. Elsewhere, add the printed directory to PATH yourself.
#
# 1. corepack: Node.js 25 and later no longer bundle it, so it comes from npm at the version and sha512 pinned
#    below (the hash is the tarball's `dist.integrity`; to move: `npm view corepack@<v> dist.integrity`). It is
#    unpacked into <dir>/corepack and run from there with node; it is never put on PATH.
# 2. The pnpm wrapper: `corepack install` fetches the pnpm that package.json pins (packageManager) and checks it
#    against the sha512 there; `corepack enable pnpm --install-directory <dir>/bin` adds only pnpm's shims.
# 3. pnpm's native binary: from pnpm 11 on, the wrapper runs a native executable (@pnpm/exe.<os>-<arch>). Under
#    corepack it would download that on first use, checked only against npm's registry signature. Instead it is
#    fetched here and checked against the sha512 that pnpm-lock.yaml records for it (packageManagerDependencies,
#    written by pnpm itself, so it moves with packageManager), then placed where the wrapper looks for an earlier
#    download (`pnpm-native` next to bin/pnpm.mjs), so the wrapper never downloads anything.
set -euo pipefail

corepack_version=0.36.0
corepack_integrity=sha512-SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==

fail() {
  echo "::error title=install-pnpm::$1"
  exit 1
}

# A path as native programs (node, the runner) want it: Windows form under Git Bash, unchanged elsewhere.
native() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

# The private directory, absolute (resolved before the cd below, so a relative <dir> means the caller's).
if [ $# -gt 1 ]; then fail 'usage: install-pnpm.sh [<dir>]'; fi
if [ $# = 1 ]; then
  [ -n "$1" ] || fail 'usage: install-pnpm.sh [<dir>]'
  if [ -e "$1" ] && [ -n "$(ls -A "$1")" ]; then fail "$1 is not empty"; fi
  mkdir -p "$1"
  prefix="$(cd "$1" && pwd)"
else
  prefix="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pnpm-toolchain.XXXXXX")"
  prefix="$(cd "$prefix" && pwd)"
fi
shims="$prefix/bin"

cd "$(dirname "$0")/../.."
tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/install-pnpm.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# fetch <spec> <sha512 integrity>: npm pack into $tmp, refuse unless the bytes match; sets $fetched.
fetch() {
  local file got
  file="$(npm pack "$1" --pack-destination="$tmp" --silent)"
  got="sha512-$(node -e "process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$tmp/$file")"
  [ "$got" = "$2" ] || fail "$1 does not match the pinned sha512 (got $got)"
  fetched="$tmp/$file"
}

# 1. corepack, unpacked into the private directory (relative names only: Git Bash's GNU tar reads the "D:" of a
#    Windows path as a remote host).
fetch "corepack@$corepack_version" "$corepack_integrity"
(cd "$tmp" && tar -xzf "${fetched##*/}" package && mv package corepack)
mv "$tmp/corepack" "$prefix/corepack"
corepack_js="$(native "$prefix/corepack/dist/corepack.js")"
corepack() { node "$corepack_js" "$@"; }

# 3a. The native binary for this runner, checked before corepack fetches anything.
version="$(node -p "/^pnpm@([0-9][^+]*)\+sha512\.[0-9a-f]{128}$/.exec(require('./package.json').packageManager)?.[1] ?? ''")"
[ -n "$version" ] || fail 'package.json packageManager is not pnpm@<version>+sha512.<hash>'
target="$(node -p "process.platform + '-' + process.arch")"
case "$target" in
  linux-x64|linux-arm64)
    # The glibc build; pnpm publishes musl builds under another name.
    [ "$(node -p "Boolean(process.report.getReport().header.glibcVersionRuntime)")" = true ] || fail "no glibc on $target" ;;
  darwin-x64|darwin-arm64|win32-x64|win32-arm64) ;;
  *) fail "no pinned pnpm binary for $target" ;;
esac
exe="@pnpm/exe.$target@$version"
# The `packages:` entry `  '<exe>':` followed by `    resolution: {integrity: sha512-…}`.
# shellcheck disable=SC2016 # JavaScript, not shell: the template literal is meant for node
integrity="$(node -e '
  const lock = require("node:fs").readFileSync("pnpm-lock.yaml", "utf8").replace(/\r\n/g, "\n");
  const head = `\n  \x27${process.argv[1]}\x27:\n    resolution: {integrity: `;
  const at = lock.indexOf(head);
  const m = at < 0 ? null : /^(sha512-[A-Za-z0-9+/]{86}==)\}/.exec(lock.slice(at + head.length));
  process.stdout.write(m ? m[1] : "");
' "$exe")"
[ -n "$integrity" ] || fail "pnpm-lock.yaml has no integrity for $exe (run pnpm install after changing packageManager)"
fetch "$exe" "$integrity"
exe_name=pnpm
[ "${target%%-*}" = win32 ] && exe_name=pnpm.exe
(cd "$tmp" && tar -xzf "${fetched##*/}" "package/$exe_name")

# 2. pnpm's shims only, into the private bin (on Windows: pnpm, pnpm.cmd, pnpm.ps1 and pnpx likewise), then the
#    pnpm wrapper (sha512-checked against packageManager).
mkdir -p "$shims"
corepack enable pnpm --install-directory "$(native "$shims")"
corepack install

# 3b. Into the wrapper's directory, where corepack put it (corepack's own rule for its home directory).
node -e "
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const [src, version, name] = process.argv.slice(1);
  const home = process.env.COREPACK_HOME ?? path.join(process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ??
    path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'), 'node/corepack');
  const dir = path.join(home, 'v1', 'pnpm', version);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.name !== 'pnpm' || pkg.version !== version || !fs.existsSync(path.join(dir, 'bin', 'pnpm.mjs'))) {
    throw new Error('no pnpm ' + version + ' wrapper in ' + dir);
  }
  // The wrapper runs an installed platform package (@pnpm/exe.*) from either place before pnpm-native.
  for (const shadow of [path.join(dir, 'node_modules'), path.join(home, 'v1', 'pnpm', '@pnpm')]) {
    if (fs.existsSync(shadow)) throw new Error('the pnpm wrapper would run a platform package from ' + shadow + ', not the checked binary');
  }
  const dest = path.join(dir, name);
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  console.log('pnpm ' + version + ': native binary ' + dest + ' (sha512-checked against pnpm-lock.yaml)');
" "$(native "$tmp/package/$exe_name")" "$version" "$([ "$exe_name" = pnpm.exe ] && echo pnpm-native.exe || echo pnpm-native)"

# The pnpm a PATH lookup finds is this one, and it is the pinned version.
PATH="$shims:$PATH"
found="$(command -v pnpm || true)"
[ "$found" = "$shims/pnpm" ] || fail "pnpm resolves to ${found:-nothing}, not $shims/pnpm"
got="$(pnpm --version)"
[ "$got" = "$version" ] || fail "pnpm $got, but package.json pins $version"

if [ -n "${GITHUB_PATH:-}" ]; then
  native "$shims" >> "$GITHUB_PATH"
  echo "pnpm $version: $(native "$shims") (first on PATH for the following steps)"
else
  echo "pnpm $version: $(native "$shims") (add it to PATH)"
fi

#!/usr/bin/env bash
# Installs corepack and pnpm for the workflows' "pnpm (corepack)" step, with every downloaded byte hash-checked
# before it is installed or run. No install script runs. Fails closed.
#
# 1. corepack: Node.js 25 and later no longer bundle it, so it comes from npm at the version and sha512 pinned
#    below (the hash is the tarball's `dist.integrity`; to move: `npm view corepack@<v> dist.integrity`).
# 2. The pnpm wrapper: `corepack install` fetches the pnpm that package.json pins (packageManager) and checks it
#    against the sha512 there.
# 3. pnpm's native binary: from pnpm 11 on, the wrapper runs a native executable (@pnpm/exe.<os>-<arch>). Under
#    corepack it would download that on first use, checked only against npm's registry signature. Instead it is
#    fetched here and checked against the sha512 that pnpm-lock.yaml records for it (packageManagerDependencies,
#    written by pnpm itself, so it moves with packageManager), then placed where the wrapper looks for an earlier
#    download (`pnpm-native` next to bin/pnpm.mjs), so the wrapper never downloads anything.
set -euo pipefail

corepack_version=0.36.0
corepack_integrity=sha512-SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==

cd "$(dirname "$0")/../.."
tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/install-pnpm.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "::error title=install-pnpm::$1"
  exit 1
}

# fetch <spec> <sha512 integrity>: npm pack into $tmp, refuse unless the bytes match; sets $fetched.
fetch() {
  local file got
  file="$(npm pack "$1" --pack-destination="$tmp" --silent)"
  got="sha512-$(node -e "process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$tmp/$file")"
  [ "$got" = "$2" ] || fail "$1 does not match the pinned sha512 (got $got)"
  fetched="$tmp/$file"
}

# 1. corepack
fetch "corepack@$corepack_version" "$corepack_integrity"
# --force: corepack also links yarn/yarnpkg shims, and runner images that ship their own yarn would otherwise fail
# with EEXIST (Windows). Only this hash-checked local tarball is installed, with no install scripts; yarn is unused.
npm install --global --force --ignore-scripts --no-audit --no-fund "$fetched"

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
bin=pnpm
[ "${target%%-*}" = win32 ] && bin=pnpm.exe
# Relative names only: Git Bash's GNU tar reads the "D:" of a Windows path as a remote host.
(cd "$tmp" && tar -xzf "${fetched##*/}" "package/$bin")

# 2. corepack and the pnpm wrapper (sha512-checked against packageManager).
corepack enable pnpm
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
" "$tmp/package/$bin" "$version" "$([ "$bin" = pnpm.exe ] && echo pnpm-native.exe || echo pnpm-native)"

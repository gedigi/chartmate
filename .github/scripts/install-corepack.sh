#!/usr/bin/env bash
# Installs corepack for the workflows' "pnpm (corepack)" step. Node.js 25 and later no longer bundle corepack, so it
# comes from npm, at the exact version and sha512 pinned here (the hash is the tarball's `dist.integrity`, checked
# before anything is installed). corepack then installs the pnpm that package.json pins (packageManager, also
# sha512-checked). No install script runs. To move to a new corepack release: `npm view corepack@<v> dist.integrity`.
set -euo pipefail

version=0.36.0
integrity=sha512-SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==

dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/corepack.XXXXXX")"
trap 'rm -rf "$dir"' EXIT
file="$(npm pack "corepack@$version" --pack-destination="$dir" --silent)"
got="sha512-$(node -e "process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$dir/$file")"
if [ "$got" != "$integrity" ]; then
  echo "::error title=corepack::corepack tarball does not match the pinned sha512 (got $got)"
  exit 1
fi
npm install --global --ignore-scripts --no-audit --no-fund "$dir/$file"
corepack --version

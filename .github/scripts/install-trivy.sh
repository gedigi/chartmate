#!/usr/bin/env bash
# Installs the Trivy vulnerability scanner for .github/scripts/scan-image.sh: the exact release pinned here, from
# its GitHub release, checked against the sha256 pinned here for this platform before anything is extracted. No
# third-party action runs. Locally (Linux or macOS on arm64): `.github/scripts/install-trivy.sh ~/.local/bin`.
#
#   .github/scripts/install-trivy.sh [dest-dir]   (default: $RUNNER_TEMP/trivy, added to $GITHUB_PATH)
#
# To move to a new release (wait a few days after it ships): take the sums from its trivy_<v>_checksums.txt (also
# Sigstore-signed: trivy_<v>_checksums.txt.sigstore.json) and check them against a download.
set -euo pipefail

version=0.75.0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=Linux-64bit ;;
  Linux-aarch64 | Linux-arm64) platform=Linux-ARM64 ;;
  Darwin-arm64) platform=macOS-ARM64 ;;
  *) echo "::error title=trivy::no pinned Trivy build for $(uname -s) $(uname -m)"; exit 1 ;;
esac
case "$platform" in
  Linux-64bit) sha256=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f ;;
  Linux-ARM64) sha256=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3 ;;
  macOS-ARM64) sha256=4a77108cccf8e55c8d6823e1e759939a622277e66cd0daa3c1fc621ed69e4568 ;;
esac

dest="${1:-${RUNNER_TEMP:?set RUNNER_TEMP or pass a directory}/trivy}"
tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trivy.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
archive="trivy_${version}_${platform}.tar.gz"
curl -fsSL --retry 3 -o "$tmp/$archive" "https://github.com/aquasecurity/trivy/releases/download/v${version}/${archive}"
if command -v sha256sum >/dev/null; then
  got="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
fi
if [ "$got" != "$sha256" ]; then
  echo "::error title=trivy::$archive does not match the pinned sha256 (got $got)"
  exit 1
fi
mkdir -p "$dest"
tar -xzf "$tmp/$archive" -C "$tmp" trivy
install -m 755 "$tmp/trivy" "$dest/trivy"
if [ -z "${1:-}" ] && [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest" >> "$GITHUB_PATH"
fi
"$dest/trivy" --version

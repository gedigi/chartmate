#!/usr/bin/env bash
# The image's vulnerability gate: fails when the image has a HIGH or CRITICAL vulnerability that already has a fix,
# in its OS packages (Debian) or its Node.js packages (node_modules, the app's production dependencies). A finding
# without a fix does not fail it (there is nothing to update to yet); the weekly rebuild (docker-refresh.yml)
# picks the fix up once it ships. Those unfixed HIGH/CRITICAL findings are listed in the job summary.
#
# Not covered: the Node.js runtime itself. The base image installs it from the official tarball, which no package
# database records, so Trivy cannot see its version (`--list-all-pkgs` lists no node package). Node.js fixes reach
# the image through the fresh base image every build pulls.
#
#   .github/scripts/scan-image.sh <image> [--platform <os/arch>] [--remote]
#
# <image> is a local image (the Docker daemon's, the default) or, with --remote, a registry reference: the
# publish jobs scan exactly the digest they pushed. Needs trivy on PATH (.github/scripts/install-trivy.sh installs
# the pinned release). No trivy.yaml is read (--config /dev/null). A finding that does not apply goes into
# .trivyignore after review, with the reason and an expiry date (see the file's header).
set -euo pipefail

usage="usage: .github/scripts/scan-image.sh <image> [--platform <os/arch>] [--remote]"
image="${1:?$usage}"
shift
source=docker
platform=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform=(--platform "${2:?$usage}"); shift 2 ;;
    --remote) source=remote; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
ignorefile="$(cd "$(dirname "$0")/../.." && pwd)/.trivyignore"
common=(--config /dev/null --image-src "$source" ${platform[@]+"${platform[@]}"} --scanners vuln --pkg-types "os,library"
  --no-progress --skip-version-check --timeout 15m)

trivy --version
status=0
trivy image "${common[@]}" --severity HIGH,CRITICAL --ignore-unfixed --ignorefile "$ignorefile" --exit-code 1 \
  --table-mode detailed "$image" || status=$?

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  label="$image${platform[1]:+ (${platform[1]})}"
  # shellcheck disable=SC2016 # literal backticks: Markdown code
  if [ "$status" = 0 ]; then
    printf 'Vulnerability scan of `%s`: no fixable HIGH/CRITICAL vulnerabilities.\n' "$label" >> "$GITHUB_STEP_SUMMARY"
  else
    printf 'Vulnerability scan of `%s`: **failed** (fixable HIGH/CRITICAL vulnerabilities, see the log).\n' "$label" >> "$GITHUB_STEP_SUMMARY"
  fi
  # For information only (never fails): HIGH/CRITICAL findings that have no fix yet.
  report="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trivy.XXXXXX")"
  if trivy image "${common[@]}" --skip-db-update --severity HIGH,CRITICAL --ignorefile "$ignorefile" --exit-code 0 \
    --format json --output "$report" "$image" >/dev/null 2>&1; then
    jq -r '[.Results[]? | .Vulnerabilities[]? | select((.FixedVersion // "") == "")
      | "| \(.Severity) | \(.VulnerabilityID) | \(.PkgName) \(.InstalledVersion) |"] | unique
      | if length == 0 then "No unfixed HIGH/CRITICAL findings.\n"
        else "<details><summary>\(length) unfixed HIGH/CRITICAL findings (no fix available yet; not failing)</summary>\n\n| Severity | ID | Package |\n|---|---|---|\n\(join("\n"))\n\n</details>\n" end' \
      "$report" >> "$GITHUB_STEP_SUMMARY" || true
  fi
  rm -f "$report"
fi
exit "$status"

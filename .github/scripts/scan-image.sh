#!/usr/bin/env bash
# The image's vulnerability gate: fails when the image has a HIGH or CRITICAL vulnerability that already has a fix,
# in its OS packages (Debian) or its Node.js packages (node_modules, the app's production dependencies). A finding
# without a fix does not fail it (there is nothing to update to yet); the weekly rebuild (docker-refresh.yml)
# picks the fix up once it ships.
#
#   .github/scripts/scan-image.sh <image>
#
# Needs trivy on PATH (.github/scripts/install-trivy.sh installs the pinned release). A finding that does not
# apply goes into .trivyignore after review, with the reason and an expiry date (see the file's header).
set -euo pipefail

image="${1:?usage: .github/scripts/scan-image.sh <image>}"
ignorefile="$(cd "$(dirname "$0")/../.." && pwd)/.trivyignore"

trivy --version
status=0
trivy image --scanners vuln --pkg-types os,library --severity HIGH,CRITICAL --ignore-unfixed \
  --ignorefile "$ignorefile" --exit-code 1 --no-progress --skip-version-check --table-mode detailed --timeout 15m \
  "$image" || status=$?

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  # shellcheck disable=SC2016 # literal backticks: Markdown code
  if [ "$status" = 0 ]; then
    printf 'Vulnerability scan of `%s`: no fixable HIGH/CRITICAL vulnerabilities.\n' "$image" >> "$GITHUB_STEP_SUMMARY"
  else
    printf 'Vulnerability scan of `%s`: **failed** (fixable HIGH/CRITICAL vulnerabilities, see the log).\n' "$image" >> "$GITHUB_STEP_SUMMARY"
  fi
fi
exit "$status"

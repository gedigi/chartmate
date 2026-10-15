#!/usr/bin/env bash
# Prints `<name>@<digest>` of one platform's image inside a multi-platform index, so a job can run each platform of
# a pushed digest: Docker's classic image store refuses to pull a second platform under the same index digest
# ("cannot overwrite digest"), but a platform manifest is its own digest (still exactly the pushed bytes).
#
#   .github/scripts/platform-digest.sh <name>@sha256:<index digest> <os>/<arch>
set -euo pipefail

usage="usage: .github/scripts/platform-digest.sh <name>@sha256:<digest> <os>/<arch>"
ref="${1:?$usage}"
platform="${2:?$usage}"
[[ "$ref" =~ ^[^@]+@sha256:[0-9a-f]{64}$ ]] || { echo "::error::not a digest reference: $ref" >&2; exit 1; }
[[ "$platform" =~ ^[a-z0-9]+/[a-z0-9]+$ ]] || { echo "$usage" >&2; exit 2; }
found="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' \
  | jq -r --arg os "${platform%/*}" --arg arch "${platform#*/}" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch) | .digest] | if length == 1 then .[0] else empty end')"
[[ "$found" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::$ref has no single $platform image" >&2; exit 1; }
printf '%s@%s\n' "${ref%@*}" "$found"

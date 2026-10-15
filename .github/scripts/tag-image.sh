#!/usr/bin/env bash
# Tags an image that was pushed by digest only (untagged) and then checked (scanned, smoke-tested), so that every tag
# points at exactly that digest: what was checked is what is published. The publish jobs of docker.yml and
# docker-refresh.yml run it last.
#
#   .github/scripts/tag-image.sh <name>@sha256:<digest> <name:tag>...
#
# `imagetools create --prefer-index=false` with a single source makes a carbon copy (same manifest, same digest);
# each tag is then read back and must resolve to that digest.
set -euo pipefail

usage="usage: .github/scripts/tag-image.sh <name>@sha256:<digest> <name:tag>..."
ref="${1:?$usage}"
shift
[ $# -gt 0 ] || { echo "$usage" >&2; exit 2; }
name="${ref%@*}"
digest="${ref#*@}"
[[ "$ref" == *@* && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error title=Tag image::not a digest reference: $ref"; exit 1; }
args=()
for t in "$@"; do
  # Only tags of the same repository: name:tag, nothing else.
  [[ "${t%:*}" == "$name" && "${t##*:}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
    || { echo "::error title=Tag image::$t is not a tag of $name"; exit 1; }
  args+=(-t "$t")
done

docker buildx imagetools create --prefer-index=false "${args[@]}" "$ref"
for t in "$@"; do
  got="$(docker buildx imagetools inspect "$t" --format '{{json .Manifest}}' | jq -r '.digest // empty')"
  [ "$got" = "$digest" ] || { echo "::error title=Tag image::$t points at $got, not the checked $digest"; exit 1; }
  echo "$t -> $digest"
done

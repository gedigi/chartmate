#!/usr/bin/env bash
# Resolves the Dockerfile's base image tag to its current digest, once per workflow run, so every build of that run
# uses the same base and the log (and the job summary) records which one. Every stage must use the same image.
#
#   .github/scripts/resolve-base-image.sh [Dockerfile]
#
# Writes to $GITHUB_OUTPUT (when set):
#   image    the base image as the Dockerfile names it (e.g. node:26-trixie-slim)
#   digest   the digest of its multi-platform index (sha256:…)
#   context  a build context that pins it: `<image>=docker-image://<image>@<digest>` (docker build
#            --build-context, docker/build-push-action build-contexts). Empty when the Dockerfile already pins a
#            digest (an older release's Dockerfile): nothing to resolve then.
set -euo pipefail

dockerfile="${1:-Dockerfile}"
# FROM [--platform=…] <image> [AS <stage>]: the first word after FROM that is not a flag.
images="$(awk 'toupper($1) == "FROM" { for (i = 2; i <= NF; i++) if ($i !~ /^--/) { print $i; break } }' "$dockerfile" | sort -u)"
if [ -z "$images" ] || [ "$(printf '%s\n' "$images" | wc -l | tr -d ' ')" != 1 ]; then
  echo "::error title=Base image::$dockerfile must build every stage on one base image (found: ${images//$'\n'/ })"
  exit 1
fi

if [[ "$images" == *@* ]]; then
  image="${images%%@*}"
  digest="${images#*@}"
  context=""
else
  image="$images"
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' | jq -r '.digest // empty')"
  context="$image=docker-image://$image@$digest"
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error title=Base image::could not resolve $image to a digest (got '$digest')"
  exit 1
fi

echo "Base image: $image@$digest"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'image=%s\ndigest=%s\ncontext=%s\n' "$image" "$digest" "$context" >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  # shellcheck disable=SC2016 # literal backticks: Markdown code
  printf 'Base image: `%s@%s`\n' "$image" "$digest" >> "$GITHUB_STEP_SUMMARY"
fi

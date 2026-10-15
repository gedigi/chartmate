#!/usr/bin/env bash
# Resolves the Dockerfile's base image tag to a digest, once per workflow run, so every build of that run uses the
# same base and the log (and the job summary) records which one. Every stage must use the same image.
#
#   .github/scripts/resolve-base-image.sh [Dockerfile]
#
# Authenticity: the base must be a Docker Official Image, and the digest one that docker-library itself recorded
# for that tag in github.com/docker-library/repo-info (repos/<name>/remote/<tag>.md, read through the GitHub API
# with `gh`; GH_TOKEN in CI). The registry's current digest is used when it appears in one of the last five
# versions of that file; when it does not (repo-info lags a fresh push by a few hours, or the registry answer is not
# docker-library's), the newest digest repo-info records is used instead, with a warning. No answer from repo-info
# fails the step. The image must also have been built recently: a `created` date in the future or more than
# MAX_AGE_DAYS (60) days old fails it.
#
# Writes to $GITHUB_OUTPUT (when set):
#   image    the base image as the Dockerfile names it (e.g. node:26-trixie-slim)
#   digest   the digest of its multi-platform index (sha256:…)
#   context  a build context that pins it: `<image>=docker-image://<image>@<digest>` (docker build
#            --build-context, docker/build-push-action build-contexts). Empty when the Dockerfile already pins a
#            digest (an older release's Dockerfile): nothing is resolved or checked then.
set -euo pipefail

dockerfile="${1:-Dockerfile}"
max_age_days="${MAX_AGE_DAYS:-60}"
fail() {
  echo "::error title=Base image::$*"
  exit 1
}

# FROM [--platform=…] <image> [AS <stage>]: the first word after FROM that is not a flag.
images="$(awk 'toupper($1) == "FROM" { for (i = 2; i <= NF; i++) if ($i !~ /^--/) { print $i; break } }' "$dockerfile" | sort -u)"
if [ -z "$images" ] || [ "$(printf '%s\n' "$images" | wc -l | tr -d ' ')" != 1 ]; then
  fail "$dockerfile must build every stage on one base image (found: ${images//$'\n'/ })"
fi

note=""
if [[ "$images" == *@* ]]; then
  image="${images%%@*}"
  digest="${images#*@}"
  context=""
else
  image="$images"
  name="${image%%:*}"
  tag="${image#*:}"
  [[ "$image" == *:* && "$name" =~ ^[a-z0-9][a-z0-9._-]*$ && "$tag" =~ ^[A-Za-z0-9._-]+$ ]] \
    || fail "$image is not a Docker Official Image tag (name:tag): its digest cannot be checked against docker-library"
  registry="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' | jq -r '.digest // empty')"
  [[ "$registry" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "could not resolve $image to a digest (got '$registry')"

  # The digests docker-library recorded for this tag, newest first (last five versions of the file).
  file="repos/$name/remote/$tag.md"
  commits="$(gh api "repos/docker-library/repo-info/commits?path=$file&per_page=5" --jq '.[].sha')" \
    || fail "could not read docker-library/repo-info's history of $file"
  recorded=()
  for sha in $commits; do
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "unexpected commit id from the GitHub API: $sha"
    d="$(gh api -H 'Accept: application/vnd.github.raw' "repos/docker-library/repo-info/contents/$file?ref=$sha" \
      | sed -n "s/^\\\$ docker pull $name@\\(sha256:[0-9a-f]\\{64\\}\\)\$/\\1/p" | head -n 1)" \
      || fail "could not read $file at docker-library/repo-info@$sha"
    if [ -n "$d" ]; then recorded+=("$d"); fi
  done
  [ "${#recorded[@]}" -gt 0 ] || fail "docker-library/repo-info records no digest for $image"
  digest="${recorded[0]}"
  for d in "${recorded[@]}"; do
    if [ "$d" = "$registry" ]; then digest="$registry"; break; fi
  done
  if [ "$digest" = "$registry" ]; then
    note="matches docker-library/repo-info"
  else
    note="the registry's $registry is not in docker-library/repo-info's last ${#recorded[@]} records; using the newest recorded one"
    echo "::warning title=Base image::$image: $note"
  fi

  # Built recently, and not in the future (an hour of clock skew allowed).
  configs="$(docker buildx imagetools inspect "$image@$digest" --format '{{json .Image}}')"
  stale="$(jq -r --argjson now "${RESOLVE_NOW:-$(date +%s)}" --argjson max "$max_age_days" '
    to_entries[] | select(.key | startswith("linux/"))
    | (.value.created // "" | sub("\\.[0-9]+"; "")) as $c
    | ($c | try fromdateiso8601 catch null) as $t
    | select($t == null or $t > $now + 3600 or $t < $now - $max * 86400)
    | "\(.key) created \(if $c == "" then "(no date)" else $c end)"' <<<"$configs")"
  [ -n "$(jq -r 'to_entries[] | select(.key | startswith("linux/")) | .key' <<<"$configs")" ] \
    || fail "$image@$digest has no linux image"
  [ -z "$stale" ] || fail "$image@$digest: created date in the future or more than $max_age_days days ago: ${stale//$'\n'/; }"
  context="$image=docker-image://$image@$digest"
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "could not resolve $image to a digest (got '$digest')"

echo "Base image: $image@$digest${note:+ ($note)}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'image=%s\ndigest=%s\ncontext=%s\n' "$image" "$digest" "$context" >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  # shellcheck disable=SC2016 # literal backticks: Markdown code
  printf 'Base image: `%s@%s`%s\n' "$image" "$digest" "${note:+ ($note)}" >> "$GITHUB_STEP_SUMMARY"
fi

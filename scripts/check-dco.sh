#!/usr/bin/env bash
# Developer Certificate of Origin check (see CONTRIBUTING.md): every non-merge commit in the range must carry a
# `Signed-off-by:` trailer with its author's email (`git commit -s`). Commits by GitHub bot accounts are exempt.
#
#   scripts/check-dco.sh <base>..<head>
set -euo pipefail

range="${1:?usage: scripts/check-dco.sh <base>..<head>}"
missing=0
checked=0
while read -r sha; do
  [ -n "$sha" ] || continue
  email=$(git log -1 --format='%ae' "$sha")
  case "$email" in *'[bot]@users.noreply.github.com') continue ;; esac
  checked=$((checked + 1))
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -qiF "<$email>"; then
    echo "::error::$(git log -1 --format='%h %s' "$sha"): no 'Signed-off-by: <name> <$email>' line"
    missing=$((missing + 1))
  fi
done < <(git rev-list --no-merges "$range")

if [ "$missing" -gt 0 ]; then
  echo "$missing commit(s) lack a sign-off. Add it with: git rebase --signoff <base> (then force-push the branch)."
  exit 1
fi
echo "DCO: $checked commit(s) signed off."

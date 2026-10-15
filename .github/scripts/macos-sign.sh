#!/bin/bash
# macOS code signing and notarization for the desktop release (.github/workflows/desktop.yml, jobs sign-mac and
# notarize-mac-dmg). Those jobs run on a fresh runner with no checkout of the dependencies: only this script, the
# entitlements plists and system tools (security, codesign, ditto, xcrun, spctl, plutil) ever see the signing key or
# the Apple credentials. No Node.js, no npm package, no electron-builder.
#
#   macos-sign.sh import                    CSC_LINK (base64 .p12), CSC_KEY_PASSWORD, IDENTITY: a temporary keychain
#                                           with the key imported non-extractable, usable by codesign only.
#   macos-sign.sh store-notary              APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID: a notarytool profile
#                                           in that keychain. Prints notarize=true|false (all three set or not).
#   macos-sign.sh sign-app <app> <entitlements> <inherit-entitlements>
#                                           IDENTITY: signs nested code inside-out (Mach-O files, then helper apps
#                                           and frameworks, deepest first), then the app; hardened runtime, secure
#                                           timestamp; verifies with codesign --verify --deep --strict.
#   macos-sign.sh sign-dmg <dmg>            IDENTITY: signs the disk image itself.
#   macos-sign.sh notarize <file>           Submits (an .app is zipped with ditto first), waits, fails unless
#                                           Accepted (printing the notary log), then staples and validates.
#   macos-sign.sh cleanup                   Deletes the keychain.
#
# IDENTITY is the full "Developer ID Application: Name (TEAMID)" name. "-" signs ad hoc (local dry runs; no
# keychain, no timestamp).
set -euo pipefail

TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KEYCHAIN="$TMP/chartmate-signing.keychain-db"
PROFILE=chartmate-notary

die() { echo "::error title=macOS signing::$*" >&2; exit 1; }
need() { for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set"; done; }

cmd_import() {
  need CSC_LINK CSC_KEY_PASSWORD IDENTITY
  local p12 pass
  p12="$(mktemp "$TMP/csc.XXXXXX")"
  # Removed whatever happens; the decoded key never outlives this function.
  trap 'rm -f "$p12"' EXIT
  printf '%s' "$CSC_LINK" | base64 --decode > "$p12" 2>/dev/null || die "CSC_LINK is not a base64-encoded .p12"
  pass="$(openssl rand -hex 32)"
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  security create-keychain -p "$pass" "$KEYCHAIN"
  security set-keychain-settings -lut 7200 "$KEYCHAIN"
  security unlock-keychain -p "$pass" "$KEYCHAIN"
  # -x: the private key is not extractable (not even by this job); -T: only codesign may use it without a prompt.
  security import "$p12" -k "$KEYCHAIN" -f pkcs12 -P "$CSC_KEY_PASSWORD" -x -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pass" "$KEYCHAIN" >/dev/null
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    # codesign resolves the certificate chain only through the search list. Only on the throwaway runner: never
    # rewrite a developer's own search list.
    # shellcheck disable=SC2046
    security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  fi
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "\"$IDENTITY\"" \
    || die "no valid identity \"$IDENTITY\" in the .p12 (wrong CHARTMATE_MAC_SIGN_IDENTITY, or an untrusted chain: export the .p12 with its certificate chain)"
  echo "imported \"$IDENTITY\" into a temporary keychain (key not extractable)"
}

cmd_store_notary() {
  if [ -z "${APPLE_ID:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -z "${APPLE_TEAM_ID:-}" ]; then
    echo "notarize=false"
    return
  fi
  need APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  [ -f "$KEYCHAIN" ] || die "run import first"
  xcrun notarytool store-credentials "$PROFILE" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" --keychain "$KEYCHAIN" >/dev/null
  echo "notarize=true"
}

# codesign with the hardened runtime and a secure timestamp (ad hoc: neither keychain nor timestamp).
sign() {
  local args=(--force --sign "$IDENTITY" --options runtime)
  if [ "$IDENTITY" != - ]; then args+=(--timestamp --keychain "$KEYCHAIN"); fi
  codesign "${args[@]}" "$@"
}

cmd_sign_app() {
  need IDENTITY
  local app="${1:?app}" ent="${2:?entitlements}" inherit="${3:?inherit entitlements}" f
  [ -d "$app" ] && [[ "$app" == *.app ]] || die "not an app bundle: $app"
  [ -f "$ent" ] && [ -f "$inherit" ] || die "entitlements not found"
  # Nested code, deepest first: Mach-O files (symlinks are not followed, so a framework's Versions/Current is not
  # visited twice), then helper apps and frameworks. Paths come NUL-separated; a newline in one is refused.
  local items=()
  while IFS= read -r -d '' f; do
    [[ "$f" == *$'\n'* ]] && die "file name with a newline: $f"
    if [ -d "$f" ] || file -b "$f" | grep -q '^Mach-O'; then items+=("$f"); fi
  done < <(find "$app/Contents" \( -type f -o -type d \( -name '*.app' -o -name '*.framework' \) \) -print0)
  local sorted=()
  while IFS= read -r f; do sorted+=("$f"); done < <(
    for f in "${items[@]}"; do printf '%d\t%s\n' "$(tr -cd / <<<"$f" | wc -c)" "$f"; done | sort -t $'\t' -k1,1nr -k2 | cut -f2-
  )
  for f in "${sorted[@]}"; do
    if [[ "$f" == *.framework ]] || { [ -f "$f" ] && ! file -b "$f" | grep -q 'executable'; }; then
      sign "$f"                                # frameworks and dylibs: no entitlements
    else
      sign --entitlements "$inherit" "$f"      # helper apps and helper executables (JIT only)
    fi
  done
  sign --entitlements "$ent" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  echo "signed $app (${#sorted[@]} nested items)"
}

cmd_sign_dmg() {
  need IDENTITY
  local dmg="${1:?dmg}"
  local args=(--force --sign "$IDENTITY")
  if [ "$IDENTITY" != - ]; then args+=(--timestamp --keychain "$KEYCHAIN"); fi
  codesign "${args[@]}" "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"
}

cmd_notarize() {
  local target="${1:?file}" upload out status id
  upload="$target"
  if [[ "$target" == *.app ]]; then
    upload="$TMP/$(basename "$target" .app)-notarize.zip"
    ditto -c -k --keepParent "$target" "$upload"
  fi
  out="$TMP/notary-$$.plist"
  xcrun notarytool submit "$upload" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" --wait --timeout 30m \
    --output-format plist > "$out" || true
  status="$(plutil -extract status raw -o - "$out" 2>/dev/null || true)"
  id="$(plutil -extract id raw -o - "$out" 2>/dev/null || true)"
  [ "$upload" = "$target" ] || rm -f "$upload"
  if [ "$status" != Accepted ]; then
    echo "::error title=Notarization failed::$target: ${status:-no result}"
    cat "$out" || true
    if [ -n "$id" ]; then xcrun notarytool log "$id" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" || true; fi
    exit 1
  fi
  xcrun stapler staple "$target"
  xcrun stapler validate "$target"
  if [[ "$target" == *.app ]]; then
    spctl -a -t exec -vv "$target"
  else
    spctl -a -t open --context context:primary-signature -v "$target"
  fi
}

cmd_cleanup() {
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
}

case "${1:-}" in
  import) cmd_import ;;
  store-notary) cmd_store_notary ;;
  sign-app) shift; cmd_sign_app "$@" ;;
  sign-dmg) shift; cmd_sign_dmg "$@" ;;
  notarize) shift; cmd_notarize "$@" ;;
  cleanup) cmd_cleanup ;;
  *) echo "usage: macos-sign.sh import|store-notary|sign-app|sign-dmg|notarize|cleanup" >&2; exit 2 ;;
esac

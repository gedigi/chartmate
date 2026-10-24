#!/bin/bash
# macOS code signing and notarization for the desktop release (.github/workflows/desktop.yml, jobs sign-mac and
# notarize-mac-dmg). Those jobs run on a fresh runner with no checkout of the dependencies: only this script, the
# entitlements plists and system tools (security, codesign, ditto, hdiutil, xcrun, spctl, plutil) ever see the
# signing key or the Apple credentials. No Node.js, no npm package, no electron-builder.
#
#   macos-sign.sh import                    CSC_LINK (base64 .p12), CSC_KEY_PASSWORD, IDENTITY: a temporary keychain
#                                           with the key imported non-extractable, usable by codesign only.
#   macos-sign.sh store-notary              APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID: a notarytool
#                                           profile in that keychain. Prints notarize=true|false; without the
#                                           credentials it fails unless ALLOW_UNNOTARIZED=true.
#   macos-sign.sh sign-app <app> <entitlements> <inherit-entitlements>
#                                           IDENTITY: refuses any code outside the expected Electron layout, then
#                                           signs nested code inside-out (deepest first), then the app; hardened
#                                           runtime, secure timestamp; verifies with codesign --verify --deep --strict.
#   macos-sign.sh cdhash <app>              Prints the app's code directory hash.
#   macos-sign.sh check-dmg <dmg> <cdhash>  Mounts the dmg read-only and fails unless its top level holds only
#                                           Chartmate.app, the Applications link, the background and Finder files,
#                                           and the app verifies and has exactly that code directory hash (the app
#                                           sign-mac signed).
#   macos-sign.sh check-zip <zip> <cdhash>  The same for a release zip: exactly Chartmate.app inside, verified,
#                                           with that code directory hash.
#   macos-sign.sh sign-dmg <dmg>            IDENTITY: signs the disk image itself.
#   macos-sign.sh notarize <file>           Submits (an .app is zipped with ditto first), waits, fails unless
#                                           Accepted (printing the notary log), then staples and validates.
#   macos-sign.sh cleanup                   Deletes the keychain.
#
# IDENTITY is the full "Developer ID Application: Name (TEAMID)" name. "-" signs ad hoc (local dry runs; no
# keychain, no timestamp). Written for /bin/bash 3.2 (macOS).
set -euo pipefail

TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KEYCHAIN="$TMP/chartmate-signing.keychain-db"
PROFILE=chartmate-notary
# Files and mounts to remove whatever happens (set before the EXIT trap can need them).
P12=""
MOUNT=""

on_exit() {
  if [ -n "$P12" ]; then rm -f "$P12"; fi
  if [ -n "$MOUNT" ]; then hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true; fi
}
trap on_exit EXIT

die() { echo "::error title=macOS signing::$*" >&2; exit 1; }
need() { for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set"; done; }

cmd_import() {
  need CSC_LINK CSC_KEY_PASSWORD IDENTITY
  local pass
  P12="$(mktemp "$TMP/csc.XXXXXX")"
  printf '%s' "$CSC_LINK" | base64 --decode > "$P12" 2>/dev/null || die "CSC_LINK is not a base64-encoded .p12"
  pass="$(openssl rand -hex 32)"
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  security create-keychain -p "$pass" "$KEYCHAIN"
  security set-keychain-settings -lut 7200 "$KEYCHAIN"
  security unlock-keychain -p "$pass" "$KEYCHAIN"
  # -x: the private key is not extractable (not even by this job); -T: only codesign may use it without a prompt.
  security import "$P12" -k "$KEYCHAIN" -f pkcs12 -P "$CSC_KEY_PASSWORD" -x -T /usr/bin/codesign >/dev/null
  rm -f "$P12"
  P12=""
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pass" "$KEYCHAIN" >/dev/null
  # codesign resolves the certificate chain only through the user's keychain search list (create-keychain
  # normally adds it; make sure). `cleanup` deletes the keychain, which also drops it from the list.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "\"$IDENTITY\"" \
    || die "no valid identity \"$IDENTITY\" in the .p12 (wrong CHARTMATE_MAC_SIGN_IDENTITY, or an untrusted" \
      "chain: export the .p12 with its certificate chain)"
  echo "imported \"$IDENTITY\" into a temporary keychain (key not extractable)"
}

cmd_store_notary() {
  if [ -z "${APPLE_ID:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -z "${APPLE_TEAM_ID:-}" ]; then
    # A signed release is notarized too, unless the owner opted out on purpose (an unnotarized app needs a
    # Gatekeeper override on first launch, like an unsigned one).
    [ "${ALLOW_UNNOTARIZED:-}" = true ] || die "no notarization credentials (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD," \
      "APPLE_TEAM_ID in the macos-signing environment): add them, or set the repository variable" \
      "CHARTMATE_ALLOW_UNNOTARIZED_MAC=true to release signed but not notarized"
    echo "::warning title=macOS not notarized::no notarization credentials (CHARTMATE_ALLOW_UNNOTARIZED_MAC=true)" >&2
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

# Every piece of code the Electron app may contain, relative to the .app (newline-separated). Anything else that is
# Mach-O, or any other bundle, is refused: the signing job must not sign whatever a build dependency planted.
# An Electron upgrade that adds a binary fails here first; extend the list after checking the new file.
expected_code() {
  local name="$1" h f
  printf '%s\n' "Contents/MacOS/$name"
  for h in "" " (GPU)" " (Renderer)" " (Plugin)"; do
    printf '%s\n' "Contents/Frameworks/$name Helper$h.app" \
      "Contents/Frameworks/$name Helper$h.app/Contents/MacOS/$name Helper$h"
  done
  for f in "Electron Framework" Squirrel Mantle ReactiveObjC; do
    printf '%s\n' "Contents/Frameworks/$f.framework" "Contents/Frameworks/$f.framework/Versions/A/$f"
  done
  for f in libEGL.dylib libGLESv2.dylib libffmpeg.dylib libvk_swiftshader.dylib; do
    printf '%s\n' "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/$f"
  done
  # app_shim_loader: Chromium's app shim loader, in the Electron framework since Electron 45.
  printf '%s\n' "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler" \
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/app_shim_loader" \
    "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"
}

cmd_sign_app() {
  need IDENTITY
  local app="${1:?app}" ent="${2:?entitlements}" inherit="${3:?inherit entitlements}" f rel allowed
  [ -d "$app" ] && [[ "$app" == *.app ]] || die "not an app bundle: $app"
  [ -f "$ent" ] && [ -f "$inherit" ] || die "entitlements not found"
  allowed="$(expected_code "$(basename "$app" .app)")"
  # Nested code: Mach-O files (symlinks are not followed, so a framework's Versions/Current is not visited twice),
  # helper apps and frameworks. Paths come NUL-separated; a newline in one is refused. Everything is checked against
  # the expected layout before anything is signed.
  local items=() unexpected=()
  while IFS= read -r -d '' f; do
    [[ "$f" == *$'\n'* ]] && die "file name with a newline: $f"
    if [ -d "$f" ] || file -b "$f" | grep -q '^Mach-O'; then
      rel="${f#"$app"/}"
      if printf '%s\n' "$allowed" | grep -Fxq -- "$rel"; then items+=("$f"); else unexpected+=("$rel"); fi
    fi
  done < <(find "$app/Contents" \( -type f -o -type d \( -name '*.app' -o -name '*.framework' \) \) -print0)
  if [ "${#unexpected[@]}" -gt 0 ]; then
    for rel in "${unexpected[@]}"; do echo "unexpected code in the app: $rel" >&2; done
    die "unexpected code in $app: refusing to sign it (see .github/scripts/macos-sign.sh, expected_code)"
  fi
  # Deepest first.
  local sorted=()
  if [ "${#items[@]}" -gt 0 ]; then
    while IFS= read -r f; do sorted+=("$f"); done < <(
      for f in "${items[@]}"; do printf '%d\t%s\n' "$(tr -cd / <<<"$f" | wc -c)" "$f"; done \
        | sort -t $'\t' -k1,1nr -k2 | cut -f2-
    )
  fi
  for f in ${sorted[@]+"${sorted[@]}"}; do
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

cmd_cdhash() {
  local hash
  hash="$(codesign -dvvv "${1:?app}" 2>&1 | sed -n 's/^CDHash=//p' | head -n 1)"
  [ -n "$hash" ] || die "no code directory hash for $1"
  printf '%s\n' "$hash"
}

cmd_check_dmg() {
  local dmg="${1:?dmg}" expected="${2:?expected cdhash}" app actual entry name
  MOUNT="$(mktemp -d "$TMP/dmg.XXXXXX")"
  hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT" >/dev/null
  # Only what electron-builder's dmg layout puts at the top level: the app, the Applications link, the window
  # background and Finder's metadata. Anything else (another app, a script, a link elsewhere) is refused.
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    case "$name" in
      Chartmate.app) [ -d "$entry" ] && [ ! -L "$entry" ] || die "$dmg: $name is not an app bundle" ;;
      Applications) [ -L "$entry" ] && [ "$(readlink "$entry")" = /Applications ] \
        || die "$dmg: Applications is not a link to /Applications" ;;
      .background) [ -d "$entry" ] && [ ! -L "$entry" ] || die "$dmg: $name is not a directory" ;;
      .background.tiff | .background.png | .DS_Store | .VolumeIcon.icns)
        [ -f "$entry" ] && [ ! -L "$entry" ] || die "$dmg: $name is not a regular file" ;;
      *) die "$dmg: unexpected top-level entry: $name" ;;
    esac
  done < <(find "$MOUNT" -mindepth 1 -maxdepth 1 -print0)
  app="$MOUNT/Chartmate.app"
  [ -d "$app" ] || die "$dmg holds no Chartmate.app"
  codesign --verify --deep --strict "$app"
  actual="$(cmd_cdhash "$app")"
  [ "$actual" = "$expected" ] || die "$dmg holds an app with cdhash $actual, not the one signed ($expected)"
  hdiutil detach "$MOUNT" >/dev/null
  MOUNT=""
  echo "$dmg holds the signed app ($actual)"
}

cmd_check_zip() {
  local zip="${1:?zip}" expected="${2:?expected cdhash}" out entries actual
  out="$(mktemp -d "$TMP/zip.XXXXXX")"
  # ditto keeps the bundle's symlinks and extended attributes, as Finder and the updater do.
  ditto -x -k "$zip" "$out"
  entries="$(find "$out" -mindepth 1 -maxdepth 1 -print | sed "s|^$out/||")"
  if [ "$entries" != Chartmate.app ] || [ -L "$out/Chartmate.app" ] || [ ! -d "$out/Chartmate.app" ]; then
    rm -rf "$out"
    die "$zip must hold exactly Chartmate.app at its top level (found: $(printf '%s' "$entries" | tr '\n' ' '))"
  fi
  if ! codesign --verify --deep --strict "$out/Chartmate.app"; then rm -rf "$out"; die "$zip: the app does not verify"; fi
  actual="$(cmd_cdhash "$out/Chartmate.app")"
  rm -rf "$out"
  [ "$actual" = "$expected" ] || die "$zip holds an app with cdhash $actual, not the one signed ($expected)"
  echo "$zip holds the signed app ($actual)"
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
  cdhash) shift; cmd_cdhash "$@" ;;
  check-dmg) shift; cmd_check_dmg "$@" ;;
  check-zip) shift; cmd_check_zip "$@" ;;
  sign-dmg) shift; cmd_sign_dmg "$@" ;;
  notarize) shift; cmd_notarize "$@" ;;
  cleanup) cmd_cleanup ;;
  *) echo "usage: macos-sign.sh import|store-notary|sign-app|cdhash|check-dmg|check-zip|sign-dmg|notarize|cleanup" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Signs, notarizes and staples a dmg electron-builder left unsigned (it notarizes
# only the .app inside), then restamps the update manifest and the dmg's blockmap,
# since stapling changes the dmg's bytes. Reads CSC_LINK, CSC_KEY_PASSWORD,
# APPLE_TEAM_ID, APPLE_API_KEY (the .p8 contents), APPLE_API_KEY_ID and
# APPLE_API_ISSUER from the environment. macOS only.
#
#   desktop-notarize-dmg.sh <dmg> <manifest.yml>
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dmg=${1:?usage: desktop-notarize-dmg.sh <dmg> <manifest.yml>}
manifest=${2:?usage: desktop-notarize-dmg.sh <dmg> <manifest.yml>}

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/desktop-notarize.XXXXXX")
keychain="$work/dmg-signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

keychain_password="$(openssl rand -hex 16)"
echo "::add-mask::$keychain_password"
printf '%s' "$CSC_LINK" | base64 --decode > "$work/cert.p12"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/cert.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
identity=$(security find-identity -v -p codesigning "$keychain" |
  awk -v team="($APPLE_TEAM_ID)" '/Developer ID Application: / && index($0, team) { print $2; exit }')
if [[ -z $identity ]]; then
  echo "::error::CSC_LINK holds no Developer ID Application identity for team $APPLE_TEAM_ID."
  exit 1
fi

codesign --sign "$identity" --keychain "$keychain" --timestamp "$dmg"

key_path="$work/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY" > "$key_path"
xcrun notarytool submit "$dmg" --wait \
  --key "$key_path" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
xcrun stapler staple "$dmg"

node "$root/factory/scripts/desktop-restamp-dmg.ts" "$dmg" "$manifest"

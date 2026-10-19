#!/usr/bin/env bash
# Checks the macOS signing secrets of the desktop-release environment without
# printing them: the Developer ID certificate, the provisioning profile and the
# notarization API key. Reads them from the environment, as the factory desktop
# workflows pass them. macOS only, apart from the check that each one is set.
# Exits 1 at the first failure with a ::error:: line naming it.
set -euo pipefail

app_id=io.github.original-solutions.t3code-factory
# Overridable so the tests can stub it; PlistBuddy is not on PATH.
plistbuddy=${PLISTBUDDY:-/usr/libexec/PlistBuddy}
required=(
  APPLE_TEAM_ID
  CSC_LINK
  CSC_KEY_PASSWORD
  MACOS_PROVISIONING_PROFILE
  APPLE_API_KEY
  APPLE_API_KEY_ID
  APPLE_API_ISSUER
)

missing=()
for name in "${required[@]}"; do
  [[ -n ${!name:-} ]] || missing+=("$name")
done
if ((${#missing[@]} > 0)); then
  echo "::error::Empty or unset: ${missing[*]}."
  exit 1
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/desktop-preflight.XXXXXX")
keychain="$work/preflight.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Developer ID certificate
cert_path="$work/preflight.p12"
keychain_password="$(openssl rand -hex 16)"
echo "::add-mask::$keychain_password"
printf '%s' "$CSC_LINK" | base64 --decode > "$cert_path"
security create-keychain -p "$keychain_password" "$keychain"
if ! security import "$cert_path" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null; then
  echo "::error::CSC_LINK is not a .p12 that CSC_KEY_PASSWORD opens."
  exit 1
fi
if ! security find-identity -v -p codesigning "$keychain" | grep -q "Developer ID Application: .*($APPLE_TEAM_ID)"; then
  echo "::error::CSC_LINK holds no valid Developer ID Application identity for team $APPLE_TEAM_ID."
  exit 1
fi
echo "ok: Developer ID Application identity for team $APPLE_TEAM_ID"

# Provisioning profile
profile_path="$work/preflight.provisionprofile"
plist="$work/preflight-profile.plist"
printf '%s' "$MACOS_PROVISIONING_PROFILE" | base64 --decode > "$profile_path"
if ! security cms -D -i "$profile_path" > "$plist"; then
  echo "::error::MACOS_PROVISIONING_PROFILE is not a provisioning profile."
  exit 1
fi
application_id="$("$plistbuddy" -c "Print :Entitlements:com.apple.application-identifier" "$plist")"
if [[ "$application_id" != "$APPLE_TEAM_ID.$app_id" ]]; then
  echo "::error::The profile is for $application_id, not $APPLE_TEAM_ID.$app_id."
  exit 1
fi
if ! "$plistbuddy" -c "Print :Entitlements:com.apple.developer.associated-domains" "$plist" >/dev/null 2>&1; then
  echo "::error::The profile does not grant Associated Domains; enable it on the App ID and regenerate the profile."
  exit 1
fi
expires="$(plutil -extract ExpirationDate raw -o - "$plist")"
if [[ "$expires" < "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ]]; then
  echo "::error::The profile expired on $expires."
  exit 1
fi
echo "ok: profile for $application_id with Associated Domains, expires $expires"

# Notarization API key
key_path="$work/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY" > "$key_path"
if ! xcrun notarytool history --key "$key_path" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" >/dev/null; then
  echo "::error::notarytool could not sign in with APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER."
  exit 1
fi
echo "ok: notarytool signed in with the API key"

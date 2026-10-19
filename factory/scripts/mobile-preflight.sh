#!/usr/bin/env bash
# Checks the iOS signing secrets of the mobile-release environment without
# printing them: the Apple Distribution certificate, the App Store provisioning
# profiles of the app, its widgets and its share extension, and that the App
# Store Connect API key is set. Reads them from the environment, as
# factory-mobile.yml passes them. macOS only, apart from the check that each one
# is set. Exits 1 at the first failure with a ::error:: line naming it.
set -euo pipefail

app_id=au.com.originalsolutions.t3codefactory
app_group="group.$app_id"
# Overridable so the tests can stub it; PlistBuddy is not on PATH.
plistbuddy=${PLISTBUDDY:-/usr/libexec/PlistBuddy}
required=(
  APPLE_TEAM_ID
  IOS_DIST_CERT_P12
  IOS_DIST_CERT_PASSWORD
  IOS_APP_PROFILE
  IOS_WIDGETS_PROFILE
  IOS_SHARING_PROFILE
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

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mobile-preflight.XXXXXX")
keychain="$work/preflight.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  exit 1
}

# Apple Distribution certificate
cert_path="$work/preflight.p12"
keychain_password="$(openssl rand -hex 16)"
echo "::add-mask::$keychain_password"
printf '%s' "$IOS_DIST_CERT_P12" | base64 --decode > "$cert_path"
security create-keychain -p "$keychain_password" "$keychain"
if ! security import "$cert_path" -k "$keychain" -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign >/dev/null; then
  fail "IOS_DIST_CERT_P12 is not a .p12 that IOS_DIST_CERT_PASSWORD opens."
fi
# Read the whole list first: under pipefail, grep -q stopping at the match kills
# security with SIGPIPE and fails a keychain that holds the identity.
identities="$(security find-identity -v -p codesigning "$keychain")" || identities=""
if ! grep -qE "\"(Apple|iPhone) Distribution: .*\($APPLE_TEAM_ID\)\"" <<<"$identities"; then
  fail "IOS_DIST_CERT_P12 holds no valid Apple Distribution identity for team $APPLE_TEAM_ID."
fi
echo "ok: Apple Distribution identity for team $APPLE_TEAM_ID"

# Prints the value at a key path of a decoded profile; fails when it is absent.
read_key() {
  "$plistbuddy" -c "Print :$2" "$1" 2>/dev/null
}

# Checks one App Store profile: its team, bundle id, distribution type, expiry
# and the App Group every target shares.
check_profile() {
  local name=$1 bundle_id=$2 profile_path plist value expires
  profile_path="$work/$name.mobileprovision"
  plist="$work/$name.plist"
  printf '%s' "${!name}" | base64 --decode > "$profile_path"
  if ! security cms -D -i "$profile_path" > "$plist" 2>/dev/null; then
    fail "$name is not a provisioning profile."
  fi
  value="$(read_key "$plist" TeamIdentifier)" || value=""
  if ! grep -qE "^[[:space:]]*$APPLE_TEAM_ID\$" <<<"$value"; then
    fail "$name is not for team $APPLE_TEAM_ID."
  fi
  value="$(read_key "$plist" Entitlements:application-identifier)" || value=""
  if [[ "$value" != "$APPLE_TEAM_ID.$bundle_id" ]]; then
    fail "$name is for $value, not $APPLE_TEAM_ID.$bundle_id."
  fi
  # Development and ad hoc profiles list devices, enterprise ones provision all
  # devices, and only App Store profiles leave get-task-allow off with neither.
  if read_key "$plist" ProvisionedDevices >/dev/null ||
    [[ "$(read_key "$plist" ProvisionsAllDevices || true)" == "true" ]] ||
    [[ "$(read_key "$plist" Entitlements:get-task-allow || true)" == "true" ]]; then
    fail "$name is not an App Store profile; make an App Store distribution profile for $bundle_id."
  fi
  expires="$(plutil -extract ExpirationDate raw -o - "$plist")"
  if [[ "$expires" < "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ]]; then
    fail "$name expired on $expires."
  fi
  value="$(read_key "$plist" Entitlements:com.apple.security.application-groups)" || value=""
  if ! grep -qE "^[[:space:]]*${app_group//./\\.}\$" <<<"$value"; then
    fail "$name does not grant App Group $app_group; enable it on the App ID and regenerate the profile."
  fi
}

check_profile IOS_APP_PROFILE "$app_id"
if ! read_key "$work/IOS_APP_PROFILE.plist" Entitlements:aps-environment >/dev/null; then
  fail "IOS_APP_PROFILE does not grant Push Notifications (aps-environment); enable it on the App ID and regenerate the profile."
fi
if ! read_key "$work/IOS_APP_PROFILE.plist" Entitlements:com.apple.developer.associated-domains >/dev/null; then
  fail "IOS_APP_PROFILE does not grant Associated Domains; enable it on the App ID and regenerate the profile."
fi
# Clerk's config plugin adds Sign in with Apple to the app's entitlements.
if ! read_key "$work/IOS_APP_PROFILE.plist" Entitlements:com.apple.developer.applesignin >/dev/null; then
  fail "IOS_APP_PROFILE does not grant Sign in with Apple; enable it on the App ID and regenerate the profile."
fi
echo "ok: IOS_APP_PROFILE is an App Store profile for $APPLE_TEAM_ID.$app_id"

check_profile IOS_WIDGETS_PROFILE "$app_id.widgets"
echo "ok: IOS_WIDGETS_PROFILE is an App Store profile for $APPLE_TEAM_ID.$app_id.widgets"

check_profile IOS_SHARING_PROFILE "$app_id.sharing"
echo "ok: IOS_SHARING_PROFILE is an App Store profile for $APPLE_TEAM_ID.$app_id.sharing"

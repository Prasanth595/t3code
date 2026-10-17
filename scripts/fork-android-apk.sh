#!/usr/bin/env bash
# Builds and signs the fork Android APK with a local Gradle build (no EAS).
# The APK holds arm64 code, and its package differs from the store app, so both
# install side by side. .github/workflows/fork-android.yml runs it after each
# Fork Release of main. See docs/fork.md "Android app".
#
# Usage:
#   scripts/fork-android-apk.sh build <unsigned.apk>
#     Needs ANDROID_HOME, a JDK 17+, T3CODE_ANDROID_VERSION_CODE (grows with each
#     build) and T3CODE_MOBILE_VERSION. Uses no signing secrets.
#   scripts/fork-android-apk.sh sign <unsigned.apk> <signed.apk>
#     Needs ANDROID_HOME, ANDROID_KEYSTORE (path), ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS.
set -euo pipefail

: "${ANDROID_HOME:?ANDROID_HOME must point to the Android SDK.}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
absolute() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"

case "${1:-}" in
  build)
    output="$(absolute "${2:?Usage: scripts/fork-android-apk.sh build <unsigned.apk>}")"
    : "${T3CODE_ANDROID_VERSION_CODE:?T3CODE_ANDROID_VERSION_CODE must be set. Android refuses an update with a lower version code.}"
    : "${T3CODE_MOBILE_VERSION:?T3CODE_MOBILE_VERSION must be set, for example the fork release version.}"
    cd "$repo/apps/mobile"
    if [[ -n "$(git ls-files android)" ]]; then
      echo "apps/mobile/android holds tracked files. A clean prebuild would overwrite them." >&2
      exit 1
    fi
    # The preview variant is the nightly app. The fork APK must not take OTA updates
    # from the upstream Expo project, because they carry upstream JavaScript.
    export APP_VARIANT=preview
    export T3CODE_MOBILE_UPDATES_ENABLED=0
    export MOBILE_VERSION_POLICY=appVersion
    export T3CODE_ANDROID_PACKAGE="${T3CODE_ANDROID_PACKAGE:-com.yardenzamir.t3code}"
    export EXPO_NO_GIT_STATUS=1
    export CI=1
    # expo-widgets 58.0.18 imports io.github.jakex7.peek.*, but the peek 0.3.2 libraries
    # it depends on ship io.github.expo.peek.*, so its Android code does not compile.
    # perl -i writes new files, so the shared pnpm store copies stay untouched.
    # Remove this once expo-widgets imports the new package (it then finds nothing).
    widgets="$(node -p 'require("path").dirname(require.resolve("expo-widgets/package.json"))')"
    stale="$(grep -rl 'io\.github\.jakex7\.peek' "$widgets/android/src" || true)"
    if [[ -n "$stale" ]]; then
      echo "Rewriting the peek package name in expo-widgets:"
      echo "$stale"
      echo "$stale" | xargs perl -pi -e 's/io\.github\.jakex7\.peek/io.github.expo.peek/g'
    fi
    vp exec expo prebuild --clean --platform android --no-install
    (cd android && ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon)
    # The Expo template signs release builds with the debug key; `sign` replaces it.
    cp android/app/build/outputs/apk/release/app-release.apk "$output"
    ;;
  sign)
    input="${2:?Usage: scripts/fork-android-apk.sh sign <unsigned.apk> <signed.apk>}"
    output="$(absolute "${3:?Usage: scripts/fork-android-apk.sh sign <unsigned.apk> <signed.apk>}")"
    : "${ANDROID_KEYSTORE:?ANDROID_KEYSTORE must be the path of the signing keystore.}"
    : "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD must be set.}"
    : "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS must be set.}"
    test -s "$ANDROID_KEYSTORE" || { echo "Keystore $ANDROID_KEYSTORE is missing or empty." >&2; exit 1; }
    "$build_tools/apksigner" sign \
      --ks "$ANDROID_KEYSTORE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
      --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEYSTORE_PASSWORD \
      --v4-signing-enabled false \
      --out "$output" "$input"
    "$build_tools/apksigner" verify --print-certs "$output" | grep -m1 "certificate DN"
    ;;
  *)
    echo "Usage: scripts/fork-android-apk.sh build <unsigned.apk> | sign <unsigned.apk> <signed.apk>" >&2
    exit 2
    ;;
esac

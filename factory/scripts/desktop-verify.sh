#!/usr/bin/env bash
# Checks a signed mac build before it is published: the .app in the zip (what the
# updater installs) and the .app in the dmg (what a first install copies) pass
# `codesign --verify --deep --strict` and Gatekeeper (`spctl -a -vv`), and the
# dmg carries a stapled notarization ticket. Exits non-zero at the first failure.
# macOS only.
#
#   desktop-verify.sh <dmg> <zip>
set -euo pipefail

dmg=${1:?usage: desktop-verify.sh <dmg> <zip>}
zip=${2:?usage: desktop-verify.sh <dmg> <zip>}

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/desktop-verify.XXXXXX")
mount="$work/dmg"
cleanup() {
  hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

check_app() {
  local app
  app=$(find "$1" -maxdepth 1 -name '*.app' -print -quit)
  if [[ -z $app ]]; then
    echo "::error::No .app in $2."
    exit 1
  fi
  echo "verify: $app ($2)"
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl -a -vv "$app"
}

xcrun stapler validate "$dmg"

ditto -x -k "$zip" "$work/zip"
check_app "$work/zip" "$(basename "$zip")"

mkdir "$mount"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" -quiet
check_app "$mount" "$(basename "$dmg")"

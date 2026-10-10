#!/usr/bin/env bash
# Build the fork macOS arm64 app, signed with the self-made fork certificate.
# It builds only the zip that the updater uses. The CI release adds the DMG.
# Usage: scripts/fork-desktop-mac.sh [--publish | --install]
# --install replaces the app in /Applications and restarts it. No GitHub round trip.
# --publish uploads the build as a prerelease on the fork, so installed fork apps update to it.
# See docs/fork.md.
set -euo pipefail

readonly FORK_REPOSITORY="Yarden-zamir/t3code"
readonly SIGN_IDENTITY="Yarden Zamir T3 Fork"

publish=false
install=false
case "${1:-}" in
  "") ;;
  --publish) publish=true ;;
  --install) install=true ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! security find-identity -v -p codesigning | grep -q "\"$SIGN_IDENTITY\""; then
  echo "No trusted code signing identity \"$SIGN_IDENTITY\" in the keychain. See docs/fork.md." >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
# Local builds use 1HHMMSS as the build number, CI uses the run number.
# The nightly updater allows downgrades, so it installs any release that differs from the running one.
version="$(node scripts/resolve-nightly-release.ts \
  --date "$(date -u +%Y%m%d)" --run-number "1$(date -u +%H%M%S)" --sha "$sha" |
  sed -n 's/^version=//p')"
if [[ -z "$version" ]]; then
  echo "Could not resolve the release version." >&2
  exit 1
fi

if [[ "$publish" == true ]] && ! git branch -r --contains "$sha" | grep -q "origin/"; then
  echo "Push $sha to origin before you publish, so the release tag points at a public commit." >&2
  exit 1
fi

rm -rf release
T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPOSITORY" \
  T3CODE_DESKTOP_MAC_SELF_SIGNED=true \
  CSC_NAME="$SIGN_IDENTITY" \
  vp run dist:desktop:artifact \
  --platform mac --target zip --arch arm64 --build-version "$version" --signed --verbose

# The build keeps only the zip, so check the app inside it.
verify_dir="$(mktemp -d)"
ditto -x -k release/*-arm64.zip "$verify_dir"
codesign --verify --deep --strict "$verify_dir"/*.app
echo "Built $version in $repo_root/release"

if [[ "$install" == true ]]; then
  app_name="$(basename "$verify_dir"/*.app)"
  installed="/Applications/$app_name"
  # One backup only: the previous install. Older backups are not kept.
  backup="$repo_root/../_shared/backup/$app_name"
  mkdir -p "$(dirname "$backup")"
  osascript -e "quit app \"${app_name%.app}\"" || true
  for _ in $(seq 1 30); do pgrep -f "$installed/Contents/MacOS/" >/dev/null || break; sleep 1; done
  if pgrep -f "$installed/Contents/MacOS/" >/dev/null; then
    echo "$app_name did not quit; the install stopped." >&2
    exit 1
  fi
  rm -rf "$backup"
  [[ -d "$installed" ]] && mv "$installed" "$backup"
  mv "$verify_dir/$app_name" "$installed"
  open "$installed"
  echo "Installed $version to $installed"
fi
rm -rf "$verify_dir"

if [[ "$publish" == true ]]; then
  shopt -s nullglob
  assets=(release/*.zip release/*.blockmap release/nightly-mac.yml)
  if [[ ! -f release/nightly-mac.yml ]]; then
    echo "release/nightly-mac.yml is missing; the updater cannot find this build." >&2
    exit 1
  fi
  gh release create "v$version" "${assets[@]}" \
    --repo "$FORK_REPOSITORY" \
    --target "$sha" \
    --title "T3 Code Fork v$version (local)" \
    --notes "Local fork build from $sha." \
    --prerelease
fi

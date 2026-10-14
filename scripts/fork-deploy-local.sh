#!/usr/bin/env bash
# Deploy a local build of this checkout to a headless Linux server over SSH, without a release.
# The server must run as the upstream background service (`t3 service install`).
# Usage:
#   scripts/fork-deploy-local.sh <ssh-host>                    build, install and switch the server
#   scripts/fork-deploy-local.sh --archive <linux-x64|linux-arm64>   build the archive only
# The script builds the `t3` executable and the web client here, and takes the native packages
# and the resource monitor from the newest fork release. It unpacks the result into
# <T3 home>/runtime/versions/<version> on the server, and runs `t3 update <version> --yes`
# there. The restart stops running agent turns. See docs/fork.md "Deploy a local build".
set -euo pipefail

readonly FORK_REPOSITORY="Yarden-zamir/t3code"
# Files that decide the native packages in the archive. A local change to one of them needs a
# release, because the archive keeps the native packages of the release.
readonly NATIVE_INPUTS=(apps/server/package.json pnpm-workspace.yaml pnpm-lock.yaml patches)

host=""
platform=""
case "${1:-}" in
  --archive)
    platform="${2:-}"
    [[ "$platform" == linux-x64 || "$platform" == linux-arm64 ]] || {
      echo "--archive needs linux-x64 or linux-arm64." >&2
      exit 2
    }
    ;;
  "" | -*)
    echo "Usage: $0 <ssh-host> | --archive <linux-x64|linux-arm64>" >&2
    exit 2
    ;;
  *) host="$1" ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
export PATH="$repo_root/node_modules/.bin:$PATH"

if [[ -n "$host" ]]; then
  case "$(ssh "$host" uname -sm)" in
    "Linux x86_64") platform=linux-x64 ;;
    "Linux aarch64") platform=linux-arm64 ;;
    *) echo "$host is not a Linux x64 or arm64 machine." >&2; exit 1 ;;
  esac
fi

# The newest CI release that servers can install: it has SHA256SUMS.
release_json="$(gh api "repos/$FORK_REPOSITORY/releases?per_page=30" \
  --jq '[.[] | select(.draft | not) | select(.name | endswith("(local)") | not)
        | select(any(.assets[]; .name == "SHA256SUMS"))][0] | {tag: .tag_name, name: .name}')"
release_tag="$(node -p 'JSON.parse(process.argv[1]).tag' "$release_json")"
release_name="$(node -p 'JSON.parse(process.argv[1]).name' "$release_json")"
release_version="${release_tag#v}"
# The release name ends with "(<12-character commit>)".
release_sha="${release_name##*(}"
release_sha="${release_sha%)}"
if [[ ! "$release_sha" =~ ^[0-9a-f]{12}$ ]]; then
  echo "Could not read the commit of release $release_tag from its name \"$release_name\"." >&2
  exit 1
fi
git cat-file -e "$release_sha^{commit}" 2>/dev/null || git fetch --quiet origin main
if ! git diff --quiet "$release_sha" -- "${NATIVE_INPUTS[@]}"; then
  echo "This checkout changes native package inputs since $release_tag (${NATIVE_INPUTS[*]})." >&2
  echo "The archive keeps the native packages of the release, so wait for a release with this change." >&2
  exit 1
fi

# Same rule as scripts/fork-desktop-mac.sh: the newest CI number plus the minute of the UTC day.
# The version sorts above the release it follows and below the next one, so auto-update replaces it.
ci_number="${release_version##*.}"
minute_of_day=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M) + 1))
version="$(node scripts/resolve-nightly-release.ts \
  --date "$(date -u +%Y%m%d)" --run-number "$((ci_number + minute_of_day))" --sha "$(git rev-parse HEAD)" |
  sed -n 's/^version=//p')"
[[ -n "$version" ]] || { echo "Could not resolve the build version." >&2; exit 1; }

work="$(mktemp -d)"
version_backup="$work/package-versions"
mkdir -p "$version_backup"
# Put back the package.json files that carry the version, also after a failure.
restore_versions() {
  local file
  for file in apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json; do
    cp "$version_backup/${file//\//_}" "$file"
  done
  rm -rf "$work"
}
for file in apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json; do
  cp "$file" "$version_backup/${file//\//_}"
done
trap restore_versions EXIT

# `--build-sea` needs an official Node build; Homebrew builds Node without it. Use the Node that
# the executable embeds (SEA_NODE_VERSION), as the release workflow does.
sea_node_version="$(sed -n 's/^const SEA_NODE_VERSION = "\(.*\)";$/\1/p' apps/server/vite.config.ts)"
host_arch="$(uname -m)"
[[ "$host_arch" == x86_64 ]] && host_arch=x64
node_name="node-v$sea_node_version-$(uname -s | tr '[:upper:]' '[:lower:]')-$host_arch"
node_dir="${XDG_CACHE_HOME:-$HOME/.cache}/t3-fork/$node_name"
if [[ ! -x "$node_dir/bin/node" ]]; then
  mkdir -p "$(dirname "$node_dir")"
  curl -fsSL -o "$work/$node_name.tar.gz" "https://nodejs.org/dist/v$sea_node_version/$node_name.tar.gz"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$sea_node_version/SHASUMS256.txt"
  (cd "$work" && grep " $node_name.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c --quiet -)
  tar -xzf "$work/$node_name.tar.gz" -C "$(dirname "$node_dir")"
fi

node scripts/update-release-package-versions.ts "$version"
vp run --filter t3 build
PATH="$node_dir/bin:$PATH" node apps/server/scripts/cli.ts build-exe --target "$platform"

base_archive="t3-$release_version-$platform.tar.gz"
curl -fsSL -o "$work/SHA256SUMS" "https://github.com/$FORK_REPOSITORY/releases/download/$release_tag/SHA256SUMS"
curl -fsSL -o "$work/$base_archive" "https://github.com/$FORK_REPOSITORY/releases/download/$release_tag/$base_archive"
(cd "$work" && grep " $base_archive\$" SHA256SUMS | shasum -a 256 -c --quiet -)

stem="t3-$version-$platform"
mkdir -p "$work/$stem"
tar -xzf "$work/$base_archive" -C "$work/$stem" --strip-components=1
cp apps/server/dist-exe/"t3-$platform" "$work/$stem/t3"
chmod 755 "$work/$stem/t3"
rm -rf "$work/$stem/client"
cp -R apps/server/dist/client "$work/$stem/client"
find "$work/$stem/client" -name '*.map' -delete
mkdir -p release
archive="$repo_root/release/$stem.tar.gz"
# No macOS metadata files or extended attributes in the archive for Linux.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$work" "$stem"
echo "Built $archive"
[[ -n "$host" ]] || exit 0

# `t3 update` checks that the new `t3` runs and reports the version, then points the service at it
# and restarts it. It does not go back by itself: see docs/fork.md for the way back.
remote_archive="/tmp/$stem.tar.gz"
scp -q "$archive" "$host:$remote_archive"
ssh "$host" bash -s -- "$version" "$remote_archive" <<'REMOTE'
set -euo pipefail
version="$1"
archive="$2"
versions="${T3CODE_HOME:-$HOME/.t3}/runtime/versions"
mkdir -p "$versions"
staging="$(mktemp -d "$versions/.staging-XXXXXX")"
trap 'rm -rf "$staging" "$archive"' EXIT
tar -xzf "$archive" -C "$staging" --strip-components=1
printf '%s\n' "$version" >"$staging/.install-complete"
rm -rf "${versions:?}/$version"
mv "$staging" "$versions/$version"
# Through the launcher link of scripts/install.sh, `t3 update` also points `t3` at the new version.
launcher="$HOME/.local/bin/t3"
[[ -x "$launcher" ]] || launcher="$versions/$version/t3"
"$launcher" update "$version" --yes
REMOTE
echo "Deployed $version to $host"

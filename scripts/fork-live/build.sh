#!/usr/bin/env bash
# Builds each new fork main commit for the desktop live server setting
# T3CODE_DESKTOP_LIVE_SERVER_DIR. A launchd agent runs it every minute
# (install-agent.sh). See "Live server updates" in docs/fork.md.
#
# Folder: <live>/a, <live>/b and <live>/c are worktrees of this repository.
# <live>/current links to the one the app runs, and <live>/ready.json names the
# one the update button offers. The script builds main in the third one, so it
# never touches a folder that runs or that is on offer.
set -euo pipefail

live="${T3CODE_DESKTOP_LIVE_SERVER_DIR:?Set T3CODE_DESKTOP_LIVE_SERVER_DIR to the live server folder.}"
# The first build (no current yet) runs from a checkout; later runs from the agent copy.
tools_checkout="$live/current"
[[ -e "$tools_checkout" ]] || tools_checkout="$(cd "$(dirname "$0")/../.." && pwd)"
git_dir="$(git -C "$tools_checkout" rev-parse --path-format=absolute --git-common-dir)"
vp="$tools_checkout/node_modules/.bin/vp"
readonly FAILED_MARKER=.t3-live-failed-sha
# "<commit> <filters>" of the last install in a build folder.
readonly INSTALLED_MARKER=.t3-live-installed
# The newest main commit that changes nothing that the live server builds.
readonly NO_BUILD_MARKER="$live/no-build-sha"
# The t3 build needs only these workspace packages and their dependencies. The
# full install also installs the mobile app and runs its slow postinstall scripts.
readonly INSTALL_FILTERS=(--filter 't3...' --filter '@t3tools/scripts...' --filter '@t3tools/monorepo')
# A change to one of these paths needs a new install.
readonly INSTALL_INPUTS=(pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches ':(glob)**/package.json')
# Paths that do not reach the server or web bundle, like NO_BUILD_PATHS in scripts/fork-vps/deploy.sh.
readonly NO_BUILD_PATHS=(
  ':(exclude)docs' ':(exclude)*.md' ':(exclude).github' ':(exclude)apps/desktop'
  ':(exclude)apps/mobile' ':(exclude)apps/marketing' ':(exclude)apps/machine-map'
  ':(exclude)*.test.ts' ':(exclude)*.test.tsx'
)

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') t3-live: $*"; }
notify() { osascript -e "display notification \"$1\" with title \"T3 live server\"" >/dev/null 2>&1 || true; }
# Runs a command and logs how long it took, so that each phase can be measured.
phase() {
  local name="$1" start=$SECONDS status=0
  shift
  "$@" || status=$?
  log "$name took $((SECONDS - start))s (exit $status)"
  return "$status"
}

git --git-dir "$git_dir" fetch --quiet origin main
sha="$(git --git-dir "$git_dir" rev-parse FETCH_HEAD)"

current="$(readlink "$live/current" 2>/dev/null || true)"
current_sha="$(git -C "$current" rev-parse HEAD 2>/dev/null || true)"
ready_sha="$(jq -r '.sha // empty' "$live/ready.json" 2>/dev/null || true)"
if [[ "$sha" == "$current_sha" || "$sha" == "$ready_sha" || "$sha" == "$(cat "$NO_BUILD_MARKER" 2>/dev/null || true)" ]]; then
  exit 0
fi

# The newest build is the one on offer, else the one that runs.
newest_sha="${ready_sha:-$current_sha}"
if [[ -n "$newest_sha" ]] &&
  [[ -z "$(git --git-dir "$git_dir" diff --name-only "$newest_sha" "$sha" -- . "${NO_BUILD_PATHS[@]}")" ]]; then
  echo "$sha" >"$NO_BUILD_MARKER"
  log "${sha:0:12} changes nothing that the live server builds; no build"
  exit 0
fi

offered="$(jq -r '.path // empty' "$live/ready.json" 2>/dev/null || true)"
newest_folder="${offered:-$current}"
# A commit that changes only server code reuses the web bundle of the newest build.
# The web build reads apps/server/package.json (licenses), so a change there rebuilds it.
web_dist_source=""
if [[ -n "$newest_folder" && -d "$newest_folder/apps/web/dist" ]] &&
  [[ "$(git -C "$newest_folder" rev-parse HEAD 2>/dev/null || true)" == "$newest_sha" ]] &&
  [[ -z "$(git --git-dir "$git_dir" diff --name-only "$newest_sha" "$sha" -- . "${NO_BUILD_PATHS[@]}" ':(exclude)apps/server')" ]] &&
  git --git-dir "$git_dir" diff --quiet "$newest_sha" "$sha" -- apps/server/package.json; then
  web_dist_source="$newest_folder/apps/web/dist"
fi
target=""
for folder in "$live/a" "$live/b" "$live/c"; do
  if [[ "$folder" != "$current" && "$folder" != "$offered" ]]; then
    target="$folder"
    break
  fi
done
if [[ "$(cat "$target/$FAILED_MARKER" 2>/dev/null || true)" == "$sha" ]]; then
  exit 0
fi
log "building ${sha:0:12} in $target"
started=$SECONDS
if [[ -d "$target" ]]; then
  git -C "$target" checkout --quiet --detach "$sha"
else
  mkdir -p "$live"
  git --git-dir "$git_dir" worktree add --quiet --detach "$target" "$sha"
fi
rm -f "$target/$FAILED_MARKER"

# Skips the install when no install input changed since the last install of this folder.
install_dependencies() {
  local installed_sha="" installed_filters=""
  read -r installed_sha installed_filters 2>/dev/null <"$INSTALLED_MARKER" || true
  if [[ -n "$installed_sha" && "$installed_filters" == "${INSTALL_FILTERS[*]}" && -d node_modules ]] &&
    git diff --quiet "$installed_sha" "$sha" -- "${INSTALL_INPUTS[@]}"; then
    log "install skipped: no dependency change since ${installed_sha:0:12}"
    return 0
  fi
  rm -f "$INSTALLED_MARKER"
  phase install env CI=1 "$vp" i "${INSTALL_FILTERS[@]}" || return 1
  echo "$sha ${INSTALL_FILTERS[*]}" >"$INSTALLED_MARKER"
}
build_bundles() {
  if [[ -z "$web_dist_source" ]]; then
    phase build "$vp" run --filter t3 build
    return
  fi
  log "web unchanged: reusing the web bundle of $web_dist_source"
  rm -rf apps/web/dist && cp -R "$web_dist_source" apps/web/dist &&
    phase server-build "$vp" run --filter t3 --ignore-depends-on build
}
build() {
  cd "$target" &&
    install_dependencies &&
    build_bundles &&
    phase brand-assets node scripts/apply-web-brand-assets.ts nightly apps/server/dist/client
}
if ! (build); then
  echo "$sha" >"$target/$FAILED_MARKER"
  log "the build of ${sha:0:12} failed after $((SECONDS - started))s"
  notify "The build of ${sha:0:12} failed. The app keeps its current server."
  exit 1
fi

if [[ -z "$current" ]]; then
  # First build: the app starts on it the next time it starts.
  ln -sfn "$target" "$live/current"
else
  subject="$(git -C "$target" log -1 --format=%s)"
  jq -n --arg path "$target" --arg sha "$sha" --arg subject "$subject" \
    --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{path: $path, sha: $sha, subject: $subject, builtAt: $builtAt}' >"$live/ready.json.next"
  mv "$live/ready.json.next" "$live/ready.json"
  notify "${subject} is ready. Use the update button to switch."
fi
# The agent runs $live/build.sh, a copy that each build updates. Thus a builder
# fix applies at once, not only after the build that carries it is installed.
cp "$target/scripts/fork-live/build.sh" "$live/build.sh.next"
mv "$live/build.sh.next" "$live/build.sh"
# The app reads the setting at its start. Set it only after a first build exists.
launchctl setenv T3CODE_DESKTOP_LIVE_SERVER_DIR "$live"
log "${sha:0:12} is ready in $target after $((SECONDS - started))s"

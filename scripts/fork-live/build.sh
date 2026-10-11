#!/usr/bin/env bash
# Builds each new fork main commit for the desktop live server setting
# T3CODE_DESKTOP_LIVE_SERVER_DIR. A launchd agent runs it every minute
# (install-agent.sh). See "Live server updates" in docs/fork.md.
#
# Folder: <live>/a and <live>/b are worktrees of this repository. <live>/current
# links to the one the app runs. The script builds main in the other one, then
# writes <live>/ready.json. The app offers that build through its update button.
set -euo pipefail

live="${T3CODE_DESKTOP_LIVE_SERVER_DIR:?Set T3CODE_DESKTOP_LIVE_SERVER_DIR to the live server folder.}"
script_checkout="$(cd "$(dirname "$0")/../.." && pwd)"
git_dir="$(git -C "$script_checkout" rev-parse --path-format=absolute --git-common-dir)"
vp="$script_checkout/node_modules/.bin/vp"
readonly FAILED_MARKER=.t3-live-failed-sha

notify() { osascript -e "display notification \"$1\" with title \"T3 live server\"" >/dev/null 2>&1 || true; }

git --git-dir "$git_dir" fetch --quiet origin main
sha="$(git --git-dir "$git_dir" rev-parse FETCH_HEAD)"

current="$(readlink "$live/current" 2>/dev/null || true)"
if [[ -n "$current" && "$(git -C "$current" rev-parse HEAD 2>/dev/null || true)" == "$sha" ]]; then
  exit 0
fi
if [[ "$(jq -r '.sha // empty' "$live/ready.json" 2>/dev/null || true)" == "$sha" ]]; then
  exit 0
fi

target="$live/a"
[[ "$current" == "$live/a" ]] && target="$live/b"
if [[ "$(cat "$target/$FAILED_MARKER" 2>/dev/null || true)" == "$sha" ]]; then
  exit 0
fi

# The previous ready build may live in the target folder, so it is no longer ready.
rm -f "$live/ready.json"
echo "t3-live: building ${sha:0:12} in $target"
if [[ -d "$target" ]]; then
  git -C "$target" checkout --quiet --detach "$sha"
else
  mkdir -p "$live"
  git --git-dir "$git_dir" worktree add --quiet --detach "$target" "$sha"
fi
rm -f "$target/$FAILED_MARKER"
if ! (cd "$target" && CI=1 "$vp" i && "$vp" run --filter t3 build &&
  node scripts/apply-web-brand-assets.ts nightly apps/server/dist/client); then
  echo "$sha" >"$target/$FAILED_MARKER"
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
# The app reads the setting at its start. Set it only after a first build exists.
launchctl setenv T3CODE_DESKTOP_LIVE_SERVER_DIR "$live"
echo "t3-live: ${sha:0:12} is ready in $target"

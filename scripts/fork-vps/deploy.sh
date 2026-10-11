#!/usr/bin/env bash
# Keep the VPS T3 server on the newest fork main. t3-deploy.timer runs this every minute.
# A server restart cancels running agent turns, so the switch waits until no agent
# turn runs. The build happens while the old server keeps running. See docs/fork.md.
#
# Layout: /opt/t3code is a link to /opt/t3code-a or /opt/t3code-b. The script builds
# main in the folder that the link does not point to, then moves the link and
# restarts t3-server. If the new server does not answer, it moves the link back.
set -euo pipefail

readonly LINK=/opt/t3code
readonly BUILT_MARKER=.t3-deploy-built-sha
readonly FAILED_MARKER=.t3-deploy-failed-sha
export PATH="/opt/node/bin:$PATH"

log() { echo "t3-deploy: $*"; }

active="$(readlink -f "$LINK")"
case "$active" in
  /opt/t3code-a) target=/opt/t3code-b ;;
  /opt/t3code-b) target=/opt/t3code-a ;;
  *) log "$LINK must link to /opt/t3code-a or /opt/t3code-b, not $active"; exit 1 ;;
esac

git -C "$active" fetch --quiet origin main
sha="$(git -C "$active" rev-parse FETCH_HEAD)"
if [[ "$(git -C "$active" rev-parse HEAD)" == "$sha" ]]; then
  exit 0
fi

# A thread in one of these states has a live provider process that a restart kills.
busy_threads() {
  local tool=("node" "$active/apps/server/dist/bin.mjs" "tool" "call")
  local project
  for project in $(cd /root/Github && "${tool[@]}" t3_project_list | jq -r '.projects[].id'); do
    (cd /root/Github && "${tool[@]}" t3_thread_list --input "$(jq -nc --arg p "$project" \
      '{projectId: $p, statuses: ["preparing", "queued", "starting", "running"], limit: 1}')") |
      jq -r '.threads[].threadId'
  done
}

# Build once per commit. A build that waits for idle agents is reused by the next run.
# A commit that failed to build is skipped until main moves on.
if [[ "$(cat "$target/$FAILED_MARKER" 2>/dev/null)" == "$sha" ]]; then
  exit 0
fi
if [[ "$(cat "$target/$BUILT_MARKER" 2>/dev/null)" != "$sha" ]]; then
  log "building ${sha:0:12} in $target"
  rm -f "$target/$BUILT_MARKER"
  git -C "$target" fetch --quiet origin main
  git -C "$target" checkout --quiet --detach "$sha"
  if ! (cd "$target" && CI=1 pnpm install --frozen-lockfile && pnpm exec vp run --filter t3 build); then
    echo "$sha" >"$target/$FAILED_MARKER"
    log "build of ${sha:0:12} failed; the server stays on $(git -C "$active" rev-parse --short HEAD)"
    exit 1
  fi
  echo "$sha" >"$target/$BUILT_MARKER"
fi

if [[ -n "$(busy_threads)" ]]; then
  log "${sha:0:12} is built; agents are running, so the switch waits for the next run"
  exit 0
fi

ln -sfn "$target" "$LINK"
systemctl restart t3-server
healthy=false
for _ in $(seq 1 30); do
  # A server that is still starting can accept a request and never answer it.
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3773/)" == 200 ]]; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  log "the new server did not answer; going back to $active"
  ln -sfn "$active" "$LINK"
  systemctl restart t3-server
  exit 1
fi
log "deployed ${sha:0:12} from $target"

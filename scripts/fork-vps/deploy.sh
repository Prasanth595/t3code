#!/usr/bin/env bash
# Deploy the newest fork CI release to the VPS T3 server. A systemd timer runs it every hour.
# It deploys at most once per UTC day, and only when no agent turn runs, because a
# server restart cancels running turns. See docs/fork.md.
#
# Layout: /opt/t3code is a link to /opt/t3code-a or /opt/t3code-b. The script builds
# the release in the folder that the link does not point to, then moves the link and
# restarts t3-server. If the new server does not answer, it moves the link back.
set -euo pipefail

readonly REPOSITORY="Yarden-zamir/t3code"
readonly LINK=/opt/t3code
readonly STAMP=/var/lib/t3-deploy/last-deploy-date
export PATH="/opt/node/bin:$PATH"

log() { echo "t3-deploy: $*"; }

today="$(date -u +%Y%m%d)"
if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$today" ]]; then
  log "already deployed today"
  exit 0
fi

active="$(readlink -f "$LINK")"
case "$active" in
  /opt/t3code-a) target=/opt/t3code-b ;;
  /opt/t3code-b) target=/opt/t3code-a ;;
  *) log "$LINK must link to /opt/t3code-a or /opt/t3code-b, not $active"; exit 1 ;;
esac

tag="$(gh release list --repo "$REPOSITORY" --exclude-drafts --limit 50 --json tagName,name \
  --jq '[.[] | select(.name | endswith("(local)") | not)][0].tagName')"
if [[ -z "$tag" ]]; then
  log "no CI release found"
  exit 1
fi
git -C "$active" fetch --quiet --no-tags origin "refs/tags/$tag:refs/tags/$tag"
sha="$(git -C "$active" rev-parse "$tag^{commit}")"
if [[ "$(git -C "$active" rev-parse HEAD)" == "$sha" ]]; then
  log "$tag is already deployed"
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
if [[ -n "$(busy_threads)" ]]; then
  log "agents are running; try again at the next timer run"
  exit 0
fi

log "building $tag ($sha) in $target"
git -C "$target" checkout --quiet --detach "$sha"
(cd "$target" && CI=1 pnpm install --frozen-lockfile && pnpm exec vp run --filter t3 build)

# The build takes minutes, so check again right before the restart.
if [[ -n "$(busy_threads)" ]]; then
  log "an agent started during the build; the next timer run deploys the ready build"
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

mkdir -p "$(dirname "$STAMP")"
echo "$today" >"$STAMP"
log "deployed $tag ($sha) from $target"

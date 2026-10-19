#!/usr/bin/env bash
# Keeps the LaunchAgent server on origin/main. The io.github.rawphp.t3fac.autodeploy job runs the
# copy install.sh puts in ~/.local/share/t3fac every 10 minutes, so it never runs from a tree that
# its own checkout changes. Each tick:
#
# - reads T3FAC_AUTODEPLOY_CLONE (a clone used for nothing else) and T3FAC_AUTODEPLOY_TOKEN (scope
#   orchestration:read) from ~/.config/t3fac/env; with no clone set it does nothing;
# - fetches origin and stops, printing nothing, when origin/main is the commit in `current`'s
#   `+fac.<sha>` or the commit whose deploy last failed;
# - after a deploy or rollback by hand, records origin/main as that commit, so what the person
#   installed stays until main moves;
# - asks GET /api/factory/status whether a run is in progress, and waits for the next tick when
#   one is or when it cannot tell;
# - checks the commit out and builds it with deploy.sh --build-only, asks again, then installs it
#   with deploy.sh, whose health check rolls back a bad version.
#
# Prints one line per deploy, failure or wait, which the job appends to autodeploy.log; the
# build's own output goes to autodeploy-build.log, replaced on each attempt.
set -euo pipefail

root="$HOME/.local/share/t3fac"
env_file="$HOME/.config/t3fac/env"
logs="$HOME/Library/Logs/t3fac"
build_log="$logs/autodeploy-build.log"
failed_file="$root/autodeploy.failed"
hold_file="$root/autodeploy.hold"
tick_lock="$root/autodeploy.lock"
deploy_lock="$root/deploy.lock"
job=io.github.rawphp.t3fac.autodeploy
# T3FAC_PORT exists only so tests can point at a stub API; the server listens on 3876.
port=${T3FAC_PORT:-3876}
# How long a build may take. T3FAC_BUILD_LIMIT exists only so tests can make a build time out.
build_limit=${T3FAC_BUILD_LIMIT:-3600}

say() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) autodeploy: $*"
}

if [[ -f $env_file ]]; then
  set +u
  # shellcheck disable=SC1090
  . "$env_file"
  set -u
fi
clone=${T3FAC_AUTODEPLOY_CLONE:-}
token=${T3FAC_AUTODEPLOY_TOKEN:-}
[[ -n $clone ]] || exit 0

mkdir -p "$root" "$logs"
source "$(dirname "${BASH_SOURCE[0]}")/lib/lock.sh"

release_locks() {
  release_lock "$tick_lock"
  release_lock "$deploy_lock"
}

# autodeploy.lock covers the whole tick, the clone and the build. deploy.lock, which install.sh
# and rollback.sh take too, is held only for the install, so a long build never locks a person
# out of rolling back.
if ! why=$(take_lock "$tick_lock" autodeploy); then
  say "$why"
  exit 0
fi
trap release_locks EXIT

# launchd starts no tick while this one runs, so a fetch that hangs would stop autodeploy for
# good: give up on a connection that stalls, and never wait on a prompt.
if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-"ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"} \
  git -C "$clone" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch -q origin 2> /dev/null; then
  say "cannot fetch origin in $clone"
  exit 1
fi
target=$(git -C "$clone" rev-parse origin/main)
short=$(git -C "$clone" rev-parse --short "$target")

installed=$(readlink "$root/current" 2> /dev/null || true)
installed=${installed##*+fac.}

# Returns 1 after a deploy or rollback by hand (lib/t3fac.sh's hold_autodeploy), first recording
# origin/main as a commit not to deploy, so the person's version is not undone before main moves.
hand_deployed() {
  [[ -f $hold_file ]] || return 0
  rm -f "$hold_file"
  echo "$target" > "$failed_file"
  say "not deploying $short until main moves: a deploy or rollback was run by hand"
  return 1
}

# build.sh names the version with a short sha whose length git picks, so compare by prefix.
if [[ -n $installed && $target == "$installed"* ]]; then
  rm -f "$hold_file"
  exit 0
fi
hand_deployed || exit 0
if [[ $(cat "$failed_file" 2> /dev/null || true) == "$target" ]]; then exit 0; fi

# Returns 0 when no factory run is in progress. Otherwise prints why it is not deploying and
# returns 1: a run that may have a session or gate at work (any unfinished run not waiting on a
# person, including one whose file cannot be read), a pass running, or a status it cannot read.
factory_idle() {
  local body busy
  if [[ -z $token ]]; then
    say "not deploying $short: T3FAC_AUTODEPLOY_TOKEN is not set in $env_file"
    return 1
  fi
  # The header goes on stdin, so the token never shows in ps.
  if ! body=$(curl -fsS -m 10 -H @- "http://127.0.0.1:$port/api/factory/status" \
    <<< "Authorization: Bearer $token" 2> /dev/null); then
    say "not deploying $short: cannot read http://127.0.0.1:$port/api/factory/status"
    return 1
  fi
  if ! busy=$(jq -r '.passes.running == true or any(.runs[];
      .unreadable or ((.state // "") | IN("pr-open", "needs-info", "stuck") | not))' \
    <<< "$body" 2> /dev/null); then
    say "not deploying $short: cannot read the factory status"
    return 1
  fi
  if [[ $busy != false ]]; then
    say "waiting to deploy $short: a factory run is in progress"
    return 1
  fi
}

failed() {
  echo "$target" > "$failed_file"
  say "deploy of $short failed; ${installed:+still on $installed; }see $build_log"
  exit 1
}

# Checks the commit out and builds it, killing the build's process group after $build_limit
# seconds: launchd starts no tick while this one runs, so a build that hangs on the network would
# stop autodeploy for good. Returns 124 on a timeout. set -m gives each background job a process
# group of its own, so one kill reaches every process the build started.
build() {
  local pid watchdog status=0 timed_out="$root/.autodeploy-timeout.$$"
  rm -f "$timed_out"
  set -m
  {
    git -C "$clone" checkout -q --detach "$target" &&
      (cd "$clone" && factory/scripts/deploy.sh --build-only)
  } &
  pid=$!
  {
    sleep "$build_limit"
    touch "$timed_out"
    kill -TERM -- "-$pid"
  } 2> /dev/null &
  watchdog=$!
  set +m
  wait "$pid" || status=$?
  kill -TERM -- "-$watchdog" 2> /dev/null || true
  wait "$watchdog" 2> /dev/null || true
  if [[ -e $timed_out ]]; then
    rm -f "$timed_out"
    return 124
  fi
  return "$status"
}

factory_idle || exit 0

# deploy.sh's install.sh reloads every timer job; T3FAC_SKIP_RELOAD keeps it from booting this
# job out, which would kill this deploy.
export T3FAC_SKIP_RELOAD=$job
: > "$build_log"
status=0
build >> "$build_log" 2>&1 || status=$?
if ((status == 124)); then
  # Most likely the network, so the commit is tried again on the next tick.
  say "build of $short took over ${build_limit}s and was stopped; trying again next tick"
  exit 1
fi
((status == 0)) || failed

# During the build a run may have started, or a person may have deployed by hand or be doing so.
factory_idle || exit 0
if ! why=$(take_lock "$deploy_lock" deploy); then
  say "$why"
  exit 0
fi
hand_deployed || exit 0
# The install.sh this runs sees it already holds the lock.
export T3FAC_DEPLOY_LOCK=$$

(cd "$clone" && factory/scripts/deploy.sh) >> "$build_log" 2>&1 || failed
say "deployed $short"

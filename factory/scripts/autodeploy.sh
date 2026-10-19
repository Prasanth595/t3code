#!/usr/bin/env bash
# Keeps the LaunchAgent server on origin/main. The io.github.rawphp.t3fac.autodeploy job runs the
# copy install.sh puts in ~/.local/share/t3fac every 10 minutes, so it never runs from a tree that
# its own checkout changes. Each tick:
#
# - reads T3FAC_AUTODEPLOY_CLONE (a clone used for nothing else) and T3FAC_AUTODEPLOY_TOKEN (scope
#   orchestration:read) from ~/.config/t3fac/env; with no clone set it does nothing;
# - fetches origin and stops, printing nothing, when origin/main is the commit in `current`'s
#   `+fac.<sha>` or the commit whose deploy last failed;
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
tick_lock="$root/autodeploy.lock"
deploy_lock="$root/deploy.lock"
job=io.github.rawphp.t3fac.autodeploy
# T3FAC_PORT exists only so tests can point at a stub API; the server listens on 3876.
port=${T3FAC_PORT:-3876}

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
# Takes lock $1, a symlink to this process's pid, taking over one whose holder has gone; prints
# a line naming the holder and returns 1 when another live process has it. The same scheme as
# lib/t3fac.sh's take_deploy_lock, copied because this copy runs without the lib.
take_lock() {
  local holder
  if ! ln -s "$$" "$1" 2> /dev/null; then
    holder=$(readlink "$1" 2> /dev/null || true)
    if [[ -n $holder ]] && kill -0 "$holder" 2> /dev/null; then
      say "another ${2} is running (pid $holder)"
      return 1
    fi
    rm -f "$1"
    if ! ln -s "$$" "$1" 2> /dev/null; then
      say "another ${2} is running"
      return 1
    fi
  fi
}

release_locks() {
  local lock
  for lock in "$tick_lock" "$deploy_lock"; do
    if [[ $(readlink "$lock" 2> /dev/null || true) == "$$" ]]; then rm -f "$lock"; fi
  done
}

# autodeploy.lock covers the whole tick, the clone and the build. deploy.lock, which install.sh
# and rollback.sh take too, is held only for the install, so a long build never locks a person
# out of rolling back.
take_lock "$tick_lock" autodeploy || exit 0
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
# build.sh names the version with a short sha whose length git picks, so compare by prefix.
if [[ -n $installed && $target == "$installed"* ]]; then exit 0; fi
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
  if ! body=$(curl -fsS -m 10 -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$port/api/factory/status" 2> /dev/null); then
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

factory_idle || exit 0

# deploy.sh's install.sh reloads every timer job; T3FAC_SKIP_RELOAD keeps it from booting this
# job out, which would kill this deploy.
export T3FAC_SKIP_RELOAD=$job
: > "$build_log"
{
  git -C "$clone" checkout -q --detach "$target" &&
    (cd "$clone" && factory/scripts/deploy.sh --build-only)
} >> "$build_log" 2>&1 || failed

# A run may have started during the build, or a person may be deploying by hand.
factory_idle || exit 0
take_lock "$deploy_lock" deploy || exit 0
# The install.sh this runs sees it already holds the lock.
export T3FAC_DEPLOY_LOCK=$$

(cd "$clone" && factory/scripts/deploy.sh) >> "$build_log" 2>&1 || failed
say "deployed $short"

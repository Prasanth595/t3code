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
lock="$root/autodeploy.lock"
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
# launchd never starts a second copy of the job, but a run by hand could overlap one. A lock
# whose holder has gone is taken over; one with no pid yet is being taken right now.
if ! mkdir "$lock" 2> /dev/null; then
  holder=$(cat "$lock/pid" 2> /dev/null || true)
  if [[ -z $holder ]] || kill -0 "$holder" 2> /dev/null; then
    say "another autodeploy is running${holder:+ (pid $holder)}"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" 2> /dev/null || exit 0
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT

if ! git -C "$clone" fetch -q origin 2> /dev/null; then
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

# A run may have started during the build.
factory_idle || exit 0

(cd "$clone" && factory/scripts/deploy.sh) >> "$build_log" 2>&1 || failed
say "deployed $short"

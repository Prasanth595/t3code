# Sourced by install.sh and rollback.sh: where versions live, the LaunchAgent job, how to
# restart it and how to tell it came up.

root="$HOME/.local/share/t3fac"
label=io.github.rawphp.t3fac
template="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../launchd" && pwd)/$label.plist"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/t3fac/t3fac.log"
# The port the plist serves on. T3FAC_PORT exists only so tests can point the health check at
# a stub listener; the plist still says 3876.
port=${T3FAC_PORT:-3876}

# Waits for launchd to report the job unloaded, up to T3FAC_UNLOAD_WAIT seconds (10).
wait_unloaded() {
  local uid=$1 wait=${T3FAC_UNLOAD_WAIT:-10} i
  for ((i = 0; i < wait * 5; i++)); do
    launchctl print "gui/$uid/$label" > /dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "job $label is still loaded ${wait}s after bootout" >&2
  return 1
}

# Writes the plist from the template, boots the job out when it is loaded, waits for it to
# unload and bootstraps it. Notes the log size first (log_before) so wait_healthy reads only
# what the restarted job writes.
restart_job() {
  local uid
  uid=$(id -u)
  log_before=$(($(wc -c 2> /dev/null < "$log" || echo 0)))
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/t3fac" "$HOME/.config/t3fac"
  sed "s|@HOME@|$HOME|g" "$template" > "$plist"
  if launchctl print "gui/$uid/$label" > /dev/null 2>&1; then
    launchctl bootout "gui/$uid/$label"
    wait_unloaded "$uid"
  fi
  launchctl bootstrap "gui/$uid" "$plist"
}

# Waits up to T3FAC_HEALTH_WAIT seconds (90) after restart_job for the server to accept
# connections on $port and for a "factory started" or "no factory config" line to appear in
# the bytes appended to the log since the restart. A log smaller than it was before the
# restart was truncated, so it is read from the start. On timeout prints what is missing and
# the last 50 log lines to stderr and returns 1.
wait_healthy() {
  local version=$1 wait=${T3FAC_HEALTH_WAIT:-90} offset=${log_before:-0}
  local i size port_ok log_ok missing
  for ((i = 0; i <= wait * 2; i++)); do
    port_ok=0
    log_ok=0
    if (exec 3<> "/dev/tcp/127.0.0.1/$port") 2> /dev/null; then port_ok=1; fi
    size=$(($(wc -c 2> /dev/null < "$log" || echo 0)))
    if ((size < offset)); then offset=0; fi
    # No -q: grep must read all of tail's output, or pipefail sees tail die of SIGPIPE.
    if tail -c +$((offset + 1)) "$log" 2> /dev/null | grep -e 'factory started' -e 'no factory config' > /dev/null; then
      log_ok=1
    fi
    if ((port_ok && log_ok)); then return 0; fi
    if ((i < wait * 2)); then sleep 0.5; fi
  done
  missing=""
  if ((!port_ok)); then missing="port $port does not accept connections"; fi
  if ((!log_ok)); then
    missing="${missing:+$missing, }no 'factory started' or 'no factory config' line in the log since the restart"
  fi
  echo "version $version failed its health check within ${wait}s: $missing" >&2
  echo "last 50 lines of $log:" >&2
  tail -n 50 "$log" >&2 2> /dev/null || true
  return 1
}

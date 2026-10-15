# Sourced by install.sh and rollback.sh: where versions live, the LaunchAgent job, and
# how to restart it.

root="$HOME/.local/share/t3fac"
label=io.github.rawphp.t3fac
template="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../launchd" && pwd)/$label.plist"
plist="$HOME/Library/LaunchAgents/$label.plist"

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
# unload and bootstraps it.
restart_job() {
  local uid
  uid=$(id -u)
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/t3fac" "$HOME/.config/t3fac"
  sed "s|@HOME@|$HOME|g" "$template" > "$plist"
  if launchctl print "gui/$uid/$label" > /dev/null 2>&1; then
    launchctl bootout "gui/$uid/$label"
    wait_unloaded "$uid"
  fi
  launchctl bootstrap "gui/$uid" "$plist"
}

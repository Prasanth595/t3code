#!/usr/bin/env bash
# Points `current` at the version installed before it and restarts the LaunchAgent job.
# Exits 1 when there is no earlier version.
set -euo pipefail

label=io.github.rawphp.t3fac
root="$HOME/.local/share/t3fac"
template="$(cd "$(dirname "$0")" && pwd)/../launchd/$label.plist"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [[ ! -L $root/previous || ! -e $root/previous ]]; then
  echo "no earlier version to roll back to" >&2
  exit 1
fi

target=$(readlink "$root/previous")
ln -sfn "$target" "$root/current"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/t3fac" "$HOME/.config/t3fac"
sed "s|@HOME@|$HOME|g" "$template" > "$plist"

uid=$(id -u)
wait_unloaded() {
  local i
  for ((i = 0; i < 50; i++)); do
    launchctl print "gui/$uid/$label" > /dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "job $label is still loaded 10s after bootout" >&2
  return 1
}
if launchctl print "gui/$uid/$label" > /dev/null 2>&1; then
  launchctl bootout "gui/$uid/$label"
  wait_unloaded
fi
launchctl bootstrap "gui/$uid" "$plist"

# Only now is the rollback done; a failed restart above leaves `previous` for a rerun.
rm -f "$root/previous"

echo "rolled back to ${target#versions/}"

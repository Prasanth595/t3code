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
rm -f "$root/previous"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/t3fac" "$HOME/.config/t3fac"
sed "s|@HOME@|$HOME|g" "$template" > "$plist"

uid=$(id -u)
if launchctl print "gui/$uid/$label" > /dev/null 2>&1; then
  launchctl bootout "gui/$uid/$label"
fi
launchctl bootstrap "gui/$uid" "$plist"

echo "rolled back to ${target#versions/}"

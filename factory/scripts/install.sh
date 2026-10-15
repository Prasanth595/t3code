#!/usr/bin/env bash
# Installs a t3fac archive under ~/.local/share/t3fac/versions, points `current` at it,
# writes the LaunchAgent plist and restarts the job. Usage: install.sh <archive>
set -euo pipefail

label=io.github.rawphp.t3fac
archive=${1:-}
if [[ -z $archive || ! -f $archive ]]; then
  echo "usage: install.sh <t3fac-<version>-darwin-arm64.tar.gz>" >&2
  exit 1
fi

name=$(basename "$archive")
if [[ $name != t3fac-*-darwin-arm64.tar.gz ]]; then
  echo "unexpected archive name: $name (want t3fac-<version>-darwin-arm64.tar.gz)" >&2
  exit 1
fi
version=${name#t3fac-}
version=${version%-darwin-arm64.tar.gz}

root="$HOME/.local/share/t3fac"
dest="$root/versions/$version"
template="$(cd "$(dirname "$0")" && pwd)/../launchd/$label.plist"
plist="$HOME/Library/LaunchAgents/$label.plist"

mkdir -p "$root/versions"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$archive" -C "$dest" --strip-components=1
if [[ ! -e $dest/t3 ]]; then
  echo "archive has no t3 binary: $name" >&2
  exit 1
fi

# Keep the version that was current as `previous`, unless it is the one being reinstalled.
if [[ -L $root/current ]]; then
  old=$(readlink "$root/current")
  if [[ $old != "versions/$version" ]]; then
    ln -sfn "$old" "$root/previous"
  fi
fi
ln -sfn "versions/$version" "$root/current"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/t3fac" "$HOME/.config/t3fac"
sed "s|@HOME@|$HOME|g" "$template" > "$plist"

uid=$(id -u)
if launchctl print "gui/$uid/$label" > /dev/null 2>&1; then
  launchctl bootout "gui/$uid/$label"
fi
launchctl bootstrap "gui/$uid" "$plist"

echo "installed $version"
echo "current -> versions/$version"
echo "job $label restarted"

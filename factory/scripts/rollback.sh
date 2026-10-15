#!/usr/bin/env bash
# Points `current` at the version installed before it and restarts the LaunchAgent job.
# Exits 1 when there is no earlier version.
set -euo pipefail

source "$(dirname "$0")/lib/t3fac.sh"

if [[ ! -L $root/previous || ! -e $root/previous ]]; then
  echo "no earlier version to roll back to" >&2
  exit 1
fi

target=$(readlink "$root/previous")
ln -sfn "$target" "$root/current"

restart_job

# Only now is the rollback done; a failed restart above leaves `previous` for a rerun.
rm -f "$root/previous"

echo "rolled back to ${target#versions/}"

#!/usr/bin/env bash
# Points `current` at the version installed before it, restarts the LaunchAgent job and
# checks it comes up. Also reinstalls the log rotation job. Exits 1 when there is no earlier
# version or the restored one is unhealthy.
set -euo pipefail

source "$(dirname "$0")/lib/t3fac.sh"

if [[ ! -L $root/previous || ! -e $root/previous ]]; then
  echo "no earlier version to roll back to" >&2
  exit 1
fi

target=$(readlink "$root/previous")
# `current` can be missing after a hand repair; the rollback still restores `previous`.
from=$(readlink "$root/current" || true)
ln -sfn "$target" "$root/current"

restart_logrotate_job
restart_job

# Only now is the rollback done; a failed restart above leaves `previous` for a rerun.
rm -f "$root/previous"

if ! wait_healthy "${target#versions/}"; then
  echo "rollback to ${target#versions/}${from:+ from ${from#versions/}} failed its health check" >&2
  exit 1
fi

echo "rolled back to ${target#versions/}"

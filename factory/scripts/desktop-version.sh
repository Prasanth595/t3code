#!/usr/bin/env bash
# Prints the version of a fork desktop build:
#   <apps/desktop/package.json version>-nightly.<YYYYMMDD>.<run number>
# The date defaults to today in UTC. The -nightly.<date>.<n> suffix is what
# resolveDesktopUpdateChannel in scripts/build-desktop-artifact.ts reads as the
# nightly channel, and a later run number always sorts higher in semver.
#
#   desktop-version.sh <run number> [<YYYYMMDD>]
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

run_number=${1:-}
date=${2:-$(date -u +%Y%m%d)}

if [[ ! $run_number =~ ^[1-9][0-9]*$ ]]; then
  echo "desktop-version: the run number must be a positive integer, not '$run_number'" >&2
  exit 1
fi
if [[ ! $date =~ ^[0-9]{8}$ ]]; then
  echo "desktop-version: the date must be YYYYMMDD, not '$date'" >&2
  exit 1
fi

version=$(node -p 'require(process.argv[1]).version' "$root/apps/desktop/package.json")
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "desktop-version: apps/desktop/package.json version '$version' is not MAJOR.MINOR.PATCH" >&2
  exit 1
fi

echo "$version-nightly.$date.$run_number"

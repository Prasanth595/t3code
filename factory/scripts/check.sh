#!/usr/bin/env bash
# The one check for this fork. Runs the seam check, the factory tests and the two
# typechecks in order, printing each step first, and stops at the first failure
# with that step's exit code. Run by people, by the factory gate and by factory-ci.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

step() {
  echo "check: $*"
  "$@" || exit $?
}

step factory/scripts/check-seams.sh
step vp test run apps/server/src/factory
step vp run --filter t3 typecheck
step vp run --filter @t3tools/web typecheck

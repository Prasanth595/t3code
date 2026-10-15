#!/usr/bin/env bash
# Fails when the tree differs from the upstream commit named in factory/UPSTREAM
# in a file that is neither factory-owned nor listed in factory/SEAMS.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
read -r _ref sha < "$root/factory/UPSTREAM"

if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  git fetch --quiet https://github.com/pingdotgg/t3code "$sha"
fi

bad=0
while IFS= read -r path; do
  case "$path" in
    apps/server/src/factory/*|apps/web/src/factory/*|factory/*|.dw/*|apps/web/src/routes/factory*|.github/workflows/factory-*)
      continue ;;
  esac
  if grep -qxF -- "$path" "$root/factory/SEAMS"; then
    continue
  fi
  echo "check-seams: not a listed seam: $path"
  bad=1
done < <(git diff --name-only "$sha" HEAD)

exit "$bad"

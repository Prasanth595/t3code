#!/usr/bin/env bash
# Builds HEAD and installs it on this Mac: build.sh, then install.sh on the archive it made.
# An archive already in release/ for this commit is installed as it is, since its name carries
# the commit; --rebuild builds it again. --build-only stops after the build, for a tree you
# want to install later or on another Mac. Refuses a tree with uncommitted changes, as build.sh
# does, so the installed version always names what is in the tree.
set -euo pipefail

root=${T3FAC_REPO_ROOT:-$(git rev-parse --show-toplevel)}
cd "$root"

rebuild=0
build_only=0
for arg in "$@"; do
  case $arg in
    --rebuild) rebuild=1 ;;
    --build-only) build_only=1 ;;
    *)
      echo "usage: deploy.sh [--rebuild] [--build-only]" >&2
      exit 2
      ;;
  esac
done

if [[ -n $(git status --porcelain) ]]; then
  echo "deploy: refusing a tree with uncommitted changes; commit or remove them" >&2
  exit 1
fi

version=$(factory/scripts/build.sh --print-version)
archive="release/t3fac-${version}-darwin-arm64.tar.gz"

if [[ $rebuild == 1 || ! -f $archive ]]; then
  factory/scripts/build.sh
  [[ -f $archive ]] || {
    echo "deploy: build.sh finished but $archive is missing" >&2
    exit 1
  }
else
  echo "deploy: reusing $archive (--rebuild to build it again)"
fi

if [[ $build_only == 1 ]]; then
  echo "$root/$archive"
  exit 0
fi

factory/scripts/install.sh "$archive"

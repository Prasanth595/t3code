#!/usr/bin/env bash
# Merges upstream's newest nightly tag into main through a pull request.
#
# Picks the newest v*-nightly.* tag at the upstream repo by version order and
# exits 0 with "up to date" when factory/UPSTREAM already names it. Otherwise it
# creates sync/<tag> from origin/main, merges the tag with --no-ff, regenerates
# apps/web/src/routeTree.gen.ts when that file conflicts, records <tag> <sha> in
# factory/UPSTREAM, commits, and runs factory/scripts/check.sh. Green: push, open
# the pull request `sync: <tag>` and merge it with a merge commit. Red: push, open
# it as a draft, and file `Sync to <tag> fails checks` with the failing step and
# the last 200 lines of its output. A conflict in any other file aborts the merge,
# pushes nothing, files or comments on `Sync to <tag> conflicts`, and exits 1.
#
# Run daily by .github/workflows/factory-sync.yml with GITHUB_TOKEN. Pull
# requests opened with that token trigger no workflows, which is why the checks
# run here and the merge happens only when they pass. Needs git, gh and vp.
# GH_TOKEN is kept from `vp i`, the generator and check.sh, which run upstream's
# code; only git push and gh see it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

upstream=${SYNC_UPSTREAM:-https://github.com/pingdotgg/t3code}
base=main
route_tree=apps/web/src/routeTree.gen.ts

tag=$(git ls-remote --refs --tags --sort=-version:refname "$upstream" 'v*-nightly.*' |
  awk 'NR == 1 { sub(".*refs/tags/", ""); print }')
if [[ -z $tag ]]; then
  echo "sync: no v*-nightly.* tag at $upstream" >&2
  exit 1
fi
if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+$ ]]; then
  echo "sync: unexpected tag name: $tag" >&2
  exit 1
fi
echo "newest nightly: $tag"

read -r current _ < factory/UPSTREAM
if [[ $current == "$tag" ]]; then
  echo "up to date"
  exit 0
fi

branch="sync/$tag"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Files or comments on the open issue with this exact title, with the body file.
file_issue() {
  local title=$1 body=$2
  shift 2
  local number
  number=$(gh issue list --state open --search "\"$title\" in:title" --json number,title \
    --jq "[.[] | select(.title == \"$title\")][0].number // empty")
  if [[ -n $number ]]; then
    gh issue comment "$number" --body-file "$body"
  else
    gh issue create --title "$title" "$@" --body-file "$body"
  fi
}

git fetch --quiet origin "$base"
git fetch --quiet --no-tags "$upstream" "refs/tags/$tag:refs/tags/$tag"
sha=$(git rev-parse "$tag^{commit}")
git checkout --quiet -B "$branch" "origin/$base"

route_tree_conflicted=0
if ! git merge --no-ff --no-commit "$tag" > "$scratch/merge.log" 2>&1; then
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ -z $conflicts ]]; then
    echo "sync: git merge $tag failed:" >&2
    cat "$scratch/merge.log" >&2
    exit 1
  fi
  others=$(grep -vxF "$route_tree" <<< "$conflicts" || true)
  if [[ -n $others ]]; then
    git merge --abort
    {
      echo "Merging \`$tag\` ($sha) into \`$base\` conflicts in these files:"
      echo
      sed 's/^/- /' <<< "$others"
      echo
      echo "The installed fork stays where it is until the merge is done by hand:"
      echo "create \`$branch\` from \`$base\`, run \`git merge --no-ff $tag\`, resolve"
      echo "these paths, run \`factory/scripts/regenerate-routes.sh\` if \`$route_tree\`"
      echo "conflicts too, write \`$tag $sha\` to \`factory/UPSTREAM\`, and open the pull request."
    } > "$scratch/conflicts.md"
    file_issue "Sync to $tag conflicts" "$scratch/conflicts.md"
    exit 1
  fi
  route_tree_conflicted=1
fi

untrusted=(env -u GH_TOKEN -u GITHUB_TOKEN)
"${untrusted[@]}" vp i
if [[ $route_tree_conflicted == 1 ]]; then
  "${untrusted[@]}" factory/scripts/regenerate-routes.sh
  git add "$route_tree"
fi
echo "$tag $sha" > factory/UPSTREAM
git add factory/UPSTREAM
git commit --quiet -m "sync: $tag"

set +e
"${untrusted[@]}" factory/scripts/check.sh 2>&1 | tee "$scratch/check.log"
check_status=${PIPESTATUS[0]}
set -e

if ! git push --quiet origin "$branch"; then
  echo "sync: push of $branch failed; $tag is not synced" >&2
  exit 1
fi

if [[ $check_status == 0 ]]; then
  {
    echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
    echo
    echo "\`factory/scripts/check.sh\` passed, so this merges on its own."
  } > "$scratch/pr.md"
  pr_url=$(gh pr create --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
  gh pr merge "$pr_url" --merge
  exit 0
fi

step=$(awk '/^check: / { step = substr($0, 8) } END { print step }' "$scratch/check.log")
{
  echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
  echo
  echo "\`$step\` failed (exit $check_status), so this stays a draft."
} > "$scratch/pr.md"
pr_url=$(gh pr create --draft --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
{
  echo "\`$branch\` merges \`$tag\` ($sha) cleanly, but \`$step\` failed with exit $check_status."
  echo "Pull request: $pr_url"
  echo
  echo "Last 200 lines of its output:"
  echo
  echo '```'
  awk '/^check: / { out = "" ; next } { out = out $0 "\n" } END { printf "%s", out }' "$scratch/check.log" |
    tail -n 200
  echo '```'
} > "$scratch/fails.md"
gh issue create --title "Sync to $tag fails checks" --label factory:proposed --body-file "$scratch/fails.md"
exit 1

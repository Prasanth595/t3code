#!/usr/bin/env bash
# Merges upstream's newest nightly tag into main through a pull request.
#
# Picks the newest v*-nightly.* tag at the upstream repo by version order and
# exits 0 with "up to date" when factory/UPSTREAM already names it. A tag whose
# sync/<tag> is already on origin waits on its open pull request (exit 0), or
# files `Sync to <tag> is stuck` when it has none. Otherwise it creates
# sync/<tag> from origin/main, merges the tag with --no-ff, regenerates
# apps/web/src/routeTree.gen.ts when that file conflicts, records <tag> <sha> in
# factory/UPSTREAM, commits, and runs factory/scripts/check.sh. Green: push, open
# the pull request `sync: <tag>`, and fast-forward main to the checked merge
# commit, which merges it; when main moved meanwhile, the pull request waits for
# a person. Red: push, open it as a draft, and file `Sync to <tag> fails checks`
# with the failing step and the last 200 lines of its output. A conflict in any
# other file, or a failing `vp i` or generator, aborts the merge and pushes
# nothing; a refused push stops too, and so does a refused fast-forward. Each
# files its own issue (`conflicts`, `fails checks`, `cannot be pushed`, `cannot
# land`) and exits 1; an open issue of the same
# kind gets a comment and the new tag in its title instead, so a lasting problem
# keeps one issue. gh targets origin's GitHub repository, never the fork's parent.
#
# Run daily by .github/workflows/factory-sync.yml with GITHUB_TOKEN. Pull
# requests opened with that token trigger no workflows, which is why the checks
# run here and the merge happens only when they pass. Needs git, gh and vp.
# GH_TOKEN is dropped from the environment of `vp i`, the generator and
# check.sh, which run upstream's code. That is hygiene, not isolation: they run
# as the same user as this script and could still dig the token out of it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

# Every gh call targets origin's repository. Without this, gh run in a fork's
# checkout opens pull requests and issues on the parent.
origin_url=$(git config --get remote.origin.url || true)
if [[ $origin_url =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
  export GH_REPO=${BASH_REMATCH[1]%.git}
else
  echo "sync: origin is not a GitHub repository: $origin_url" >&2
  exit 1
fi

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

# What main records, not the checkout, which an earlier local run may have left
# on a sync branch.
git fetch --quiet origin "$base"
read -r current _ < <(git show "origin/$base:factory/UPSTREAM")
if [[ $current == "$tag" ]]; then
  echo "up to date"
  exit 0
fi

branch="sync/$tag"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Files `Sync to <tag> <kind>`, or comments on the open issue of that kind and
# retitles it to this tag, so a problem that lasts across tags keeps one issue.
# The search is fuzzy, so the exact match happens here, not in gh. Extra
# arguments go to `gh issue create`.
file_issue() {
  local kind=$1 body=$2
  shift 2
  local title="Sync to $tag $kind" number
  number=$(gh issue list --state open --search "\"$kind\" in:title" --json number,title \
    --jq '.[] | "\(.number)\t\(.title)"' |
    awk -F '\t' -v kind="$kind" '
      $2 ~ ("^Sync to v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]+\\.[0-9]+ " kind "$") { print $1; exit }')
  if [[ -n $number ]]; then
    gh issue edit "$number" --title "$title"
    gh issue comment "$number" --body-file "$body"
  else
    gh issue create --title "$title" "$@" --body-file "$body"
  fi
}

# Runs upstream's code without the token, printing its output and keeping it in
# $scratch/<log>. Dropping the token is hygiene, not isolation (see the top).
run_untrusted() {
  local log=$1 status
  shift
  set +e
  env -u GH_TOKEN -u GITHUB_TOKEN "$@" 2>&1 | tee "$scratch/$log"
  status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

# Files `Sync to <tag> fails checks` with a summary naming the failed step and
# the last 200 lines of its output, then exits 1.
fails_checks() {
  local summary=$1 output=$2
  {
    echo "$summary"
    echo
    echo "Last 200 lines of its output:"
    echo
    echo '```'
    tail -n 200 "$output"
    echo '```'
  } > "$scratch/fails.md"
  file_issue "fails checks" "$scratch/fails.md" --label factory:proposed
  exit 1
}

# A step that fails before anything is committed: abort the merge, push
# nothing, and file the step's output.
fails_before_commit() {
  local step=$1 status=$2 log=$3
  git merge --abort
  echo "sync: $step failed with exit $status; $tag is not synced" >&2
  fails_checks "Merging \`$tag\` ($sha) into \`$base\` stopped: \`$step\` failed with exit $status, so nothing was pushed." "$scratch/$log"
}

# A sync branch already on origin belongs to an earlier run: its open pull
# request waits for a person, who has the issue that run filed (`fails checks`
# or `cannot land`); without one, the run that pushed it stopped early.
if git ls-remote --exit-code --heads origin "$branch" > /dev/null; then
  pr_url=$(gh pr list --head "$branch" --state open --json url --jq '.[0].url // empty')
  if [[ -n $pr_url ]]; then
    echo "sync: $tag waits on $pr_url"
    exit 0
  fi
  echo "sync: $branch is on origin with no open pull request; $tag is not synced" >&2
  {
    echo "\`$branch\` is on \`origin\` with no open pull request, so \`$tag\` is not synced."
    echo "An earlier run pushed it and stopped before its pull request was opened, or the"
    echo "pull request was closed. Delete the branch to sync the tag again."
  } > "$scratch/stuck.md"
  file_issue "is stuck" "$scratch/stuck.md"
  exit 1
fi

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
    file_issue conflicts "$scratch/conflicts.md"
    exit 1
  fi
  route_tree_conflicted=1
fi

status=0
run_untrusted install.log vp i || status=$?
[[ $status == 0 ]] || fails_before_commit "vp i" "$status" install.log
if [[ $route_tree_conflicted == 1 ]]; then
  run_untrusted regenerate.log factory/scripts/regenerate-routes.sh || status=$?
  [[ $status == 0 ]] || fails_before_commit factory/scripts/regenerate-routes.sh "$status" regenerate.log
  git add "$route_tree"
fi
echo "$tag $sha" > factory/UPSTREAM
git add factory/UPSTREAM
git commit --quiet -m "sync: $tag"

check_status=0
run_untrusted check.log factory/scripts/check.sh || check_status=$?

if ! git push --quiet origin "$branch" 2> "$scratch/push.log"; then
  cat "$scratch/push.log" >&2
  echo "sync: push of $branch failed; $tag is not synced" >&2
  {
    echo "\`$branch\` merges \`$tag\` ($sha), but pushing it failed, so nothing reached \`$base\`."
    echo "\`GITHUB_TOKEN\` cannot push changes under \`.github/workflows/\`; when the tag changes"
    echo "upstream's workflows, the push needs a token with the workflows permission."
    echo
    echo '```'
    tail -n 50 "$scratch/push.log"
    echo '```'
  } > "$scratch/push.md"
  file_issue "cannot be pushed" "$scratch/push.md"
  exit 1
fi

if [[ $check_status == 0 ]]; then
  {
    echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
    echo
    echo "\`factory/scripts/check.sh\` passed, so this merges on its own."
  } > "$scratch/pr.md"
  pr_url=$(gh pr create --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
  # Fast-forwarding main to the checked merge commit lands exactly what the checks
  # ran on, and GitHub marks the pull request merged. When main moved meanwhile,
  # the push is refused and the pull request waits for a person.
  if git push --quiet origin "$branch:$base" 2> "$scratch/land.log"; then
    echo "sync: $tag merged into $base through $pr_url"
    exit 0
  fi
  cat "$scratch/land.log" >&2
  echo "sync: $base could not be fast-forwarded to $branch; $pr_url waits for a person" >&2
  {
    echo "\`$branch\` merges \`$tag\` ($sha) and passed the checks, but \`$base\` could not be"
    echo "fast-forwarded to it: \`$base\` moved while the checks ran, or it refuses the push."
    echo "The checks ran on the \`$base\` the branch was cut from, not the current one, so"
    echo "this needs a person: merge \`$base\` into the branch, run \`factory/scripts/check.sh\`,"
    echo "then merge the pull request. Until then each run waits on it."
    echo "Pull request: $pr_url"
  } > "$scratch/land.md"
  file_issue "cannot land" "$scratch/land.md"
  exit 1
fi

step=$(awk '/^check: / { step = substr($0, 8) } END { print step }' "$scratch/check.log")
{
  echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
  echo
  echo "\`$step\` failed (exit $check_status), so this stays a draft."
} > "$scratch/pr.md"
pr_url=$(gh pr create --draft --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
awk '/^check: / { out = "" ; next } { out = out $0 "\n" } END { printf "%s", out }' \
  "$scratch/check.log" > "$scratch/step.log"
fails_checks "\`$branch\` merges \`$tag\` ($sha) cleanly, but \`$step\` failed with exit $check_status.
Pull request: $pr_url" "$scratch/step.log"

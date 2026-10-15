# Factory

This is `original-solutions/t3code-factory`, a fork of `pingdotgg/t3code` that runs the software factory inside the T3 server. The design is in [docs/design.md](docs/design.md).

## Seam rule

The only upstream files this fork edits are the ones listed in [SEAMS](SEAMS). [UPSTREAM](UPSTREAM) names the upstream ref and commit the fork is based on. `scripts/check-seams.sh` diffs the committed HEAD against that commit (commit first; staged, unstaged and untracked changes are not checked) and fails on any changed path that is not factory-owned (`apps/server/src/factory/`, `apps/web/src/factory/`, `factory/`, `.dw/`, `apps/web/src/routes/factory*`, `.github/workflows/factory-*`) and not listed in `SEAMS`.

## Boundary rule

Only `apps/server/src/factory/t3/` may import T3 internals. Other files under `apps/server/src/factory/` import relative paths only from inside that folder, and no package that `apps/server/package.json` takes from the workspace (`@t3tools/*`, `effect-acp`, ...). Nothing outside `apps/server/src/factory/` imports the factory, except `apps/server/src/server.ts`. `apps/server/src/factory/boundary.test.ts` enforces both.

## Checks

`factory/scripts/check.sh` runs these steps in order, printing each name first, and stops at the first failure with that step's exit code:

1. `factory/scripts/check-seams.sh`
2. `vp test run apps/server/src/factory`
3. `vp run --filter t3 typecheck`
4. `vp run --filter @t3tools/web typecheck`

The same script is the factory gate (`gate` in `.dw/config.yml`) and the `factory-ci` GitHub workflow. To run it locally from the repo root:

```sh
vp i
factory/scripts/check.sh
```

Build, install and roll back the darwin-arm64 binary (LaunchAgent `io.github.rawphp.t3fac`, port 3876):

```sh
factory/scripts/build.sh                      # clean tree only: build, smoke test, then -> release/t3fac-<version>-darwin-arm64.tar.gz
factory/scripts/install.sh <archive>          # unpack, point `current` at it, restart the job
factory/scripts/rollback.sh                   # point `current` at the previous version, restart the job
```

## Syncing with upstream

`factory/scripts/sync.sh` merges upstream's newest `v*-nightly.*` tag into `main` through a pull request. `.github/workflows/factory-sync.yml` runs it daily at 03:17 UTC and on `workflow_dispatch`; it also runs from a checkout with `git`, `gh` and `vp` on the path and `SYNC_UPSTREAM` pointing at another repo when needed. Its pull requests and issues go to the GitHub repository `origin` names, never the fork's parent.

It picks the newest tag by version order and exits with `up to date` when [UPSTREAM](UPSTREAM) on `main` already names it. When `sync/<tag>` is already on `origin` from an earlier run, it waits on that branch's open pull request, or files `Sync to <tag> is stuck` when there is none; delete the branch to sync the tag again. Otherwise it merges the tag on `sync/<tag>` from `origin/main`, regenerates the route tree with `factory/scripts/regenerate-routes.sh` when only that file conflicts, records `<tag> <sha>` in `UPSTREAM`, commits and runs `check.sh`. Green checks open `sync: <tag>` and fast-forward `main` to the checked merge commit, which merges the pull request with exactly what the checks ran on. When `main` moved while the checks ran, the pull request stays open for a person and the run files `Sync to <tag> cannot land`; later runs wait on that pull request. Red checks open it as a draft and file `Sync to <tag> fails checks`, labelled `factory:proposed`, with the failing step and the last 200 lines of its output.

These stop the run, push nothing, and file an issue:

- A conflict in any file other than the route tree files `Sync to <tag> conflicts` with the paths.
- A failing `vp i` or route generator files `Sync to <tag> fails checks` with its output.
- A push `GITHUB_TOKEN` refuses files `Sync to <tag> cannot be pushed`. `GITHUB_TOKEN` cannot push changes under `.github/workflows/`, so every tag that changes upstream's workflows stops here until the workflow pushes with a token that has the workflows permission.

When an issue of the same kind is already open, the run comments on it and puts the new tag in its title, so a problem that lasts across tags keeps one issue.

Pull requests opened with `GITHUB_TOKEN` trigger no workflows, which is why the script runs the checks itself and merges only when they pass. `vp i`, the generator and `check.sh` run upstream's code, so the script drops `GH_TOKEN` from their environment; that is hygiene, not a boundary.

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

## Syncing with upstream

`factory/scripts/sync.sh` merges upstream's newest `v*-nightly.*` tag into `main` through a pull request. `.github/workflows/factory-sync.yml` runs it daily at 03:17 UTC and on `workflow_dispatch`; it also runs from a checkout with `git`, `gh` and `vp` on the path and `SYNC_UPSTREAM` pointing at another repo when needed.

It picks the newest tag by version order and exits with `up to date` when [UPSTREAM](UPSTREAM) already names it. Otherwise it merges the tag on `sync/<tag>` from `origin/main`, regenerates the route tree with `factory/scripts/regenerate-routes.sh` when only that file conflicts, records `<tag> <sha>` in `UPSTREAM`, commits and runs `check.sh`. Green checks open `sync: <tag>` and merge it with a merge commit. Red checks open it as a draft and file `Sync to <tag> fails checks`, labelled `factory:proposed`, with the failing step and the last 200 lines of its output. A conflict in any other file aborts the merge, pushes nothing, and files `Sync to <tag> conflicts` listing the paths, or comments on that issue when it is already open.

Pull requests opened with `GITHUB_TOKEN` trigger no workflows, which is why the script runs the checks itself and merges only when they pass.

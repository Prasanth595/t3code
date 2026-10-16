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
factory/scripts/install.sh <archive>          # unpack, point `current` at it, restart the job, wait for it to come up, roll back if it does not
factory/scripts/rollback.sh                   # point `current` at the previous version, restart the job and check it comes up
```

## Recovery

`install.sh` and `rollback.sh` check that the job came up. After the restart they wait up to `T3FAC_HEALTH_WAIT` seconds (default 90) for the server to accept connections on port 3876 and for a `factory started` or `no factory config` line to be written to `~/Library/Logs/t3fac/t3fac.log` after the restart. Lines from before the restart do not count. If either is missing, the script prints the last 50 log lines. A failed `install.sh` then runs `rollback.sh` and exits 1 with `install of <version> failed its health check; rolled back to <previous>`. With no earlier version it exits 1 and says so.

### Telling the fork is down

```sh
launchctl print gui/$(id -u)/io.github.rawphp.t3fac
tail -n 50 ~/Library/Logs/t3fac/t3fac.log
```

A non-zero exit from `launchctl print`, or output with no `pid` line, means the job is not running. A `last exit code` other than 0 together with a changing `runs` count is a crash loop. In the log, look for `factory started` or `no factory config` after the last start. Neither means the server never got as far as the factory.

### Rolling back by hand

```sh
factory/scripts/rollback.sh
```

It points `current` at `previous`, restarts the job, removes `previous` and runs the same health check on the restored version. It exits 1 with `rollback to <previous> from <current> failed its health check` when that check fails too. When there is no `previous`, install an older archive from `release/` with `factory/scripts/install.sh <archive>`.

### Handing this repo back to the Rust factory

Do this when every installed version has a bug that stops the fork from building its own fix. It is the reverse of the #21 switch.

1. Check that no run of either factory holds an issue for this repo: `softfac runs list` for the Rust factory, `softfac runs list --data-dir ~/.config/t3fac/factory` for the fork, and `gh issue list --repo original-solutions/t3code-factory --label factory:building` and `--label factory:triage` both come back empty.
2. Remove `original-solutions/t3code-factory` from `repos` in `~/.config/t3fac/factory/config.yml`.
3. Add it to `repos` in `~/.config/softfac/config.yml` with `repo`, `path` and `user`.
4. Restart each factory so it rereads its config.

The Rust factory then builds the fix.

### Moving it back

Once `install.sh` has installed a fixed archive and it passed its health check, repeat the steps above in reverse: check that no run holds an issue, remove the repo from `~/.config/softfac/config.yml`, add it to `repos` in `~/.config/t3fac/factory/config.yml`, and restart each factory.

## Syncing with upstream

`factory/scripts/sync.sh` merges upstream's newest `v*-nightly.*` tag into `main` through a pull request. `.github/workflows/factory-sync.yml` runs it daily at 03:17 UTC and on `workflow_dispatch`, as two jobs:

1. `sync.sh prepare <dir>` has no write token. It merges, runs `vp i`, the route generator and `check.sh`, which all run upstream's code, and leaves the outcome and a git bundle of the branch in `<dir>`.
2. `sync.sh publish <dir>` holds `GITHUB_TOKEN` and runs only `git` and `gh`. It refuses a bundled branch that is not the merge of `main` and the tag, apart from `factory/UPSTREAM` and a regenerated route tree. Then it pushes, lands or files.

Run with no arguments, it does both from one checkout, with `git`, `gh` and `vp` on the path and `SYNC_UPSTREAM` pointing at another repo when needed. Its pull requests and issues go to the GitHub repository `origin` names, never the fork's parent.

It picks the newest tag by version order and exits with `up to date` when [UPSTREAM](UPSTREAM) on `main` already names it. When `sync/<tag>` is already on `origin` from an earlier run, it waits on that branch's open pull request, or files `Sync to <tag> is stuck` when there is none; delete the branch to sync the tag again. Otherwise it merges the tag on `sync/<tag>` from `origin/main`, regenerates the route tree with `factory/scripts/regenerate-routes.sh` when only that file conflicts, records `<tag> <sha>` in `UPSTREAM`, commits and runs `check.sh`. Green checks open `sync: <tag>` and fast-forward `main` to the checked merge commit, which merges the pull request with exactly what the checks ran on. When `main` moved while the checks ran, the pull request stays open for a person and the run files `Sync to <tag> cannot land`. When the route tree was regenerated, nothing outside the first job has checked that file, so the pull request stays open and the run files `Sync to <tag> needs a route-tree review`; a person reviews the file and merges. Later runs wait on either pull request. Red checks open it as a draft and file `Sync to <tag> fails checks`, labelled `factory:proposed`, with the failing step and the last 200 lines of its output.

These stop the run, push nothing, and file an issue:

- A conflict in any file other than the route tree files `Sync to <tag> conflicts` with the paths. That includes the upstream files the fork edits ([SEAMS](SEAMS)); they are merged by hand.
- A failing `vp i` or route generator files `Sync to <tag> fails checks` with its output.
- A push `GITHUB_TOKEN` refuses files `Sync to <tag> cannot be pushed`. `GITHUB_TOKEN` cannot push changes under `.github/workflows/`, so every tag that changes upstream's workflows stops here until the workflow pushes with a token that has the workflows permission.

When an issue of the same kind is already open, the run comments on it and puts the new tag in its title, so a problem that lasts across tags keeps one issue.

Pull requests opened with `GITHUB_TOKEN` trigger no workflows, which is why the script runs the checks itself and lands only when they pass. Two things stay the first job's word, since checking them means running upstream's code: whether the checks passed, and the content of a regenerated route tree. Code that compromised that job could land upstream's merge unchecked, but a regenerated route tree always waits for a person, and the job never holds the write token.

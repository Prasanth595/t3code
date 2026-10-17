# Factory

This is `original-solutions/t3code-factory`, a fork of `pingdotgg/t3code` that runs the software factory inside the T3 server. The design is in [docs/design.md](docs/design.md).

## Seam rule

[AGENTS.md](AGENTS.md) is how to write a seam edit that survives the next sync; the repo's `CLAUDE.md` loads it beside upstream's `AGENTS.md`.

The only upstream files this fork edits are the ones listed in [SEAMS](SEAMS). [UPSTREAM](UPSTREAM) names the upstream ref and commit the fork is based on. `scripts/check-seams.sh` diffs the committed HEAD against that commit (commit first; staged, unstaged and untracked changes are not checked) and fails on any changed path that is not factory-owned (`apps/server/src/factory/`, `apps/web/src/factory/`, `factory/`, `.dw/`, `apps/web/src/routes/factory*`, `.github/workflows/factory-*`) and not listed in `SEAMS`.

## Boundary rule

Only `apps/server/src/factory/t3/` may import T3 internals. Other files under `apps/server/src/factory/` import relative paths only from inside that folder, and no package that `apps/server/package.json` takes from the workspace (`@t3tools/*`, `effect-acp`, ...). Nothing outside `apps/server/src/factory/` imports the factory, except `apps/server/src/server.ts`. `apps/server/src/factory/boundary.test.ts` enforces both.

## Checks

`factory/scripts/check.sh` runs these steps in order, printing each name first, and stops at the first failure with that step's exit code:

1. `factory/scripts/check-seams.sh`
2. `vp test run apps/server/src/factory`
3. `vp run --filter t3 typecheck`
4. `vp run --filter @t3tools/web typecheck`

The same script is the factory gate (`gate` in `.dw/config.yml`) and the `Check` job of the `factory-ci` GitHub workflow. The workflow has a second job, `Lint`, which runs `vp check` (upstream's lint and format check, the command upstream's `ci.yml` Lint job runs) beside `check.sh`. The gate does not run it. To run `check.sh` locally from the repo root:

```sh
vp i
factory/scripts/check.sh
```

Build and install the darwin-arm64 binary on this Mac (LaunchAgent `io.github.rawphp.t3fac`, port 3876) in one step:

```sh
factory/scripts/deploy.sh                     # build.sh then install.sh; reuses release/ for this commit, --rebuild to build again, --build-only to stop before install
```

The build needs current stable Rust, the toolchain upstream's CI uses; `rustup update stable` when cargo says a crate wants a newer rustc.

The steps on their own:

```sh
factory/scripts/build.sh                      # clean tree only: build, smoke test, then -> release/t3fac-<version>-darwin-arm64.tar.gz
factory/scripts/install.sh <archive>          # unpack, point `current` at it, restart the job, wait for it to come up, roll back if it does not
factory/scripts/rollback.sh                   # point `current` at the previous version, restart the job and check it comes up
```

## Desktop app

Build the macOS app with `vp run dist:desktop:dmg:arm64`. The dmg is unsigned by default and lands under `release/`. The first time you open an unsigned app, right-click it and choose Open.

It installs and runs beside upstream T3 Code and shares nothing with it, or with the LaunchAgent server: its own bundle id (`io.github.original-solutions.t3code-factory`), name (`T3 Code Factory`), app data (`~/Library/Application Support/t3code-factory`), T3 home (`~/.t3code-factory`), `t3code-factory://` URL scheme, backend port scan from 3880 and launchd label (`io.github.original-solutions.t3code-factory.service`). A local build has no update feed unless `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` is set. The identity values live in `packages/shared/src/forkIdentity.ts`.

Sign-in through Clerk needs the fork's redirects in the Clerk instance the app's publishable key points at, in place of upstream's `t3code://app/` and `t3code-dev://app/` from `docs/operations/connect-setup.md`: add `t3code-factory://app/` and `t3code-factory-dev://app/` to the SSO redirect allowlist and the matching origins to the Backend API `allowed_origins`. Without them Clerk rejects the desktop callback and relay sign-in fails.

Linux and Windows keep upstream's identity (desktop entry, WM class, `t3code.service`, the Linux `protocols` block): the fork ships no desktop build for them, and a fork server on Linux installing its boot service would take over upstream's unit.

## Logs

The server writes to `~/Library/Logs/t3fac/t3fac.log`. launchd never rotates that file, and a crash-looping server writes the most and cannot rotate it itself, so a second LaunchAgent, `io.github.rawphp.t3fac.logrotate`, runs `~/.local/share/t3fac/rotate-log.sh` every 10 minutes. When the log is over 20 MB it copies it to `t3fac.log.1`, shifts the older copies up (`.2.gz` to `.5.gz`, gzipped), deletes anything past the fifth and empties `t3fac.log` in place, so the running server keeps writing to the same open file. The rotator's own output goes to `~/Library/Logs/t3fac/logrotate.log` and stays tiny: it prints one line per rotation and nothing otherwise.

`install.sh` and `rollback.sh` copy the script to `~/.local/share/t3fac` and reload this job before they restart the server; restarting the server alone does not touch it. To change the limits, add `<max_mb>` and `<keep>` as two more `<string>` entries after the log path in the ProgramArguments of `factory/launchd/io.github.rawphp.t3fac.logrotate.plist`. The next `install.sh <archive>` or `rollback.sh` writes it to `~/Library/LaunchAgents`. Both also restart the server and run the health check, which can roll the server back, so do not run one only to change the limits. To apply the change now without a restart, edit `~/Library/LaunchAgents/io.github.rawphp.t3fac.logrotate.plist` the same way, then `launchctl bootout gui/$(id -u)/io.github.rawphp.t3fac.logrotate` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.rawphp.t3fac.logrotate.plist`. An edit made only there lasts until the next `install.sh` or `rollback.sh`, which rewrite that file from the template; with the template's defaults back, the next rotation deletes every copy past the fifth.

Lines the server writes between the copy and the truncate are lost, a few at most.

## Recovery

`install.sh` and `rollback.sh` check that the job came up. After the restart they wait up to `T3FAC_HEALTH_WAIT` seconds (default 90) for the server to accept connections on port 3876 and for a `factory started` or `no factory config` line to be written to `~/Library/Logs/t3fac/t3fac.log` after the restart. Lines from before the restart do not count. If either is missing, the script prints the last 50 log lines. A failed `install.sh` then runs `rollback.sh` and exits 1 with `install of <version> failed its health check; rolled back to <previous>`. With no earlier version it exits 1 and says so.

### Telling the fork is down

```sh
launchctl print gui/$(id -u)/io.github.rawphp.t3fac
tail -n 50 ~/Library/Logs/t3fac/t3fac.log
```

A non-zero exit from `launchctl print`, or output with no `pid` line, means the job is not running. A `last exit code` other than 0 together with a changing `runs` count is a crash loop. In the log, look for `factory started` or `no factory config` after the last start. Neither means the server never got as far as the factory, or the factory found an error in `~/.config/t3fac/factory/config.yml`: it logs each error as `<file>: <field>: <message>` and stays idle. A config error fails the health check too, so `install.sh` rolls back a good archive until the config is fixed.

### Rolling back by hand

```sh
factory/scripts/rollback.sh
```

It points `current` at `previous`, restarts the job, removes `previous` and runs the same health check on the restored version. It exits 1 with `rollback to <previous> from <current> failed its health check` when that check fails too. When there is no `previous`, install an older archive from `release/` with `factory/scripts/install.sh <archive>`.

A version from before #93 requires `model_instance` and `model` in `~/.config/t3fac/factory/config.yml`. The current version does not read them: it warns about them and keeps them through a save from `/settings/factory`, but never adds them, so a file copied from `factory/config.example.yml` or first written by the settings page has neither. Before rolling back to such a version, check the file has both keys and add them if not, or the restored server fails its health check with `model: is missing`. Delete them once no rollback to such a version is possible.

### Handing the repo over and back

[docs/handover.md](docs/handover.md) is the runbook for switching this repo from the Rust factory to the fork's factory, and for handing it back and moving it back.

## Remote

The Factory pages work on a phone. They run in the fork's own web, so open the fork server from the phone and sign in like any T3 browser. The T3 mobile app from the App Store is upstream's build and has no Factory screen.

1. Join the Mac and the phone to the same tailnet.
2. On the Mac, pair with the fork's binary and base dir (the LaunchAgent already serves on port 3876):

   ```sh
   ~/.local/share/t3fac/current/t3 pair --base-dir ~/.config/t3fac --tailscale
   ```

   It maps the server to Tailscale HTTPS and prints a pairing link such as `https://<machine>.<tailnet>.ts.net/pair#token=...`. Treat the link as a password.

3. Open the link in the phone's browser, which signs it in. Then open `/factory` on that same origin. The machine config is at `/settings/factory`. It names no model: each issue's session runs on the T3 project's default model, falling back to the default model in T3's own Settings, so the model is picked once, in T3.
4. Add it to the home screen: in iOS Safari, Share, then Add to Home Screen; in Android Chrome, the menu, then Add to home screen.

The pages use the paired session, so there is no factory token to set. Pause, resume and stop need the `orchestration:operate` scope that a normal pairing carries. A connection through T3 Connect (the relay) does not reach the Factory pages yet; pair directly as above.

### Desktop app

The fork's desktop app has its own built-in server, which runs no factory. To see the factory there, pair the LaunchAgent server (port 3876) as an environment in Settings, Connections, using a pairing link from the same `t3 pair` command: with `--tailscale` for a link over the tailnet, or without it on the Mac itself. The Factory pages then show that server's runs and controls, and the sidebar badge counts its attention items. One factory runs per machine, so the pages pick the first connected environment that reports a running factory, the primary first.

## Stopping a run by hand

```sh
factory/scripts/stop-run.sh <run id>      # e.g. original-solutions__t3code-factory__20__1
```

It checks that the run has a ledger, is not finished and is `building`, then leaves a request in `<data dir>/stop-requests/<run id>` (the data dir is `$T3FAC_DATA`, default `~/.config/t3fac/factory`). It exits 1 with the reason for any other run and writes nothing else. The next pass takes the request into the run's ledger as a `stop_requested` line, archives the session, removes its worktree and sends the issue to `factory:stuck` with the reason `stopped by hand`, without reading what the session was doing. A run that is no longer building by the time the pass looks has its request dropped and the pass says so. The other way to end a run that is still building, or has not started building, is to close its issue: the factory archives the session and finishes the run, and writes nothing on GitHub. A `pr-open` run whose issue is closed is abandoned the same way only when the factory is about to act on it again: a gate is about to run (its head or the base branch moved), or a feedback read found new instructor feedback; until then it waits, and it still ends when its pull request is merged or closed first, with `pr_end` in its summary line, as does a building run whose own pull request was merged or closed.

## Restarting the server

```sh
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3876/api/factory/restart
```

`POST /api/factory/restart` needs a session with `environment:maintain`, the scope T3 asks for its own process control; `orchestration:operate` alone gets 403. It answers 202 `{"restarting": true, "message": "..."}`, then writes `factory restart requested` to `~/Library/Logs/t3fac/t3fac.log` and shuts down. A clean shutdown exits 0: the interrupt's exit code 130 is made 0. A teardown that fails keeps its own code, so an exit other than 0 after `factory restart requested` means the shutdown failed. A shutdown that hangs is cut short after 10 seconds with exit 0 and a `shutdown did not finish` line on stderr. Under the LaunchAgent `io.github.rawphp.t3fac` (`KeepAlive` true, `ThrottleInterval` 10) launchd starts the server again in about 10 seconds, on whatever `current` points at. A restart installs nothing: `install.sh <archive>` is how a version changes, and it restarts the job on its own. A gate running at the time is killed with the server, and the next pass re-runs it from a fresh checkout. A second request while a restart is under way answers 409 `{"code": "restart_pending", "message": "..."}`. Under a dev server (`vp dev`, no launchd job) the process simply exits. launchd restarts a crash the same way, so the `factory restart requested` line is what tells the two apart in the log.

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

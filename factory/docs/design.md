# Factory inside a T3 Code fork: experiment design

Status: draft for Tom's review. Date: 2026-10-15.

## Why

softfac and T3 Code are two apps today. softfac is a Rust daemon that drives a separate `t3 serve` over an undocumented wire format. That means two installs, two LaunchAgents, two update paths, two logs, and an orchestration layer that copies thread state into its own ledger so it can survive crashes between "send" and "record".

The experiment puts the factory inside a fork of T3 Code as one product. The factory code knows T3's internals. T3's code never imports the factory. The fork keeps taking upstream changes.

This is an experiment. The Rust softfac keeps running and keeps building its repos. The fork replaces it only if the numbers below say it should.

## What we know about T3 Code (main at 339179f, 2026-10-15)

- pnpm monorepo on Node 24, Effect v4, vitest, oxlint, all wrapped by the `vp` (Vite+) toolchain. MIT licence.
- `apps/server` is the `t3` CLI. `apps/web` is React 19 with TanStack Router and file-based routes. `apps/desktop` is Electron.
- The server is one Effect `Layer` graph in `apps/server/src/server.ts`. Background workers sit in `layerRuntimeCoreDependenciesBase` as `Layer.effectDiscard(...)` entries. `PullRequestSyncReactor` is a worker that reads projections and dispatches commands, which is the same shape the factory needs.
- Orchestration v2 is event-sourced on SQLite (`<base>/userdata/statev2.sqlite`). In-process entry points:
  - `OrchestratorV2.dispatch(command)` for every thread command, with command receipts, so a command id is idempotent.
  - `EventSinkV2.stream({ threadId?, afterSequence?, eventType? })` replays from a sequence and then goes live.
  - `ProjectionStoreV2` is the read model.
  - `ThreadLaunchService` starts a thread in its own worktree.
  - `ProcessRunner.run({ command, args, cwd, env, timeout, maxOutputBytes })` returns stdout, stderr, exit code and a timed-out flag.
- There is no plugin mechanism. Upstream's `AGENTS.md` says many users run forks.
- Upstream moves fast: about 350 commits a week across the repo, about 24 a week in `orchestration-v2/`, about 10 in `server.ts` and about 14 in `ws.ts`.
- Release: `vp pack` builds the server bundle, and `T3CODE_PACK_EXE=1` wraps it as a Node single-executable app (`t3`). `scripts/build-cli-archive.ts` puts `t3`, `client/` (the web build), `resource-monitor/` (a small Rust binary) and the native `node_modules/` into one archive. Nightly versions are `<next patch>-nightly.<YYYYMMDD>.<run number>`, released every 30 minutes when main has changed.

## Shape

```
┌──────────────────────── t3 serve (the fork, one process) ────────────────────────┐
│                                                                                  │
│  upstream T3 (untouched)                     factory (new directories only)      │
│  ─────────────────────────                   ──────────────────────────────      │
│  OrchestratorV2 ◄──── dispatch ───────────── factory/t3/sessions.ts              │
│  EventSinkV2 ─────── stream(run.updated) ──► factory/t3/events.ts ─┐             │
│  ProjectionStoreV2 ◄─ read thread/run ─────── factory/t3/sessions.ts│            │
│  ThreadLaunchService ◄ launch ─────────────── factory/t3/sessions.ts│            │
│  node:child_process ◄ gh, git, gate cmds ──── factory/process.ts    │            │
│  ServerConfig ─────── base dir, worktrees ──► factory/t3/paths.ts   │            │
│                                                                     ▼            │
│  server.ts  +1 line: FactoryLayer ──────────► factory/index.ts ─► pass loop      │
│  server.ts  +1 line: FactoryRoutes ─────────► factory/http.ts      (60s + wakes) │
│                                                                                  │
│  web: routes/factory.tsx, routes/factory.$runId.tsx  ◄── /api/factory/*          │
└──────────────────────────────────────────────────────────────────────────────────┘
         │ gh CLI (GH_CONFIG_DIR)                     │ JSONL ledger
         ▼                                            ▼
      GitHub issues, labels, PRs              <base>/factory/runs/*.jsonl
```

One process, one binary, one LaunchAgent, one log. A second LaunchAgent, `io.github.rawphp.t3fac.logrotate`, only rotates that log on a timer, because a crash-looping server writes the most log and cannot rotate it itself. Agent sessions are ordinary T3 threads, so the T3 UI shows them next to a Factory page.

## Code layout in the fork

```
apps/server/src/factory/
  index.ts          FactoryLayer: the only symbol server.ts imports
  process.ts        node:child_process with env allowlist, process group kill and a bounded output tail
  t3/               the adapter: the only factory code that imports T3 internals
    sessions.ts     launch, send, archive, status over ThreadLaunchService, OrchestratorV2, ProjectionStoreV2
    events.ts       EventSinkV2.stream → wake the run that owns the thread
    paths.ts        ServerConfig → base dir, worktrees dir, factory dir
  domain/           pure: lifecycle states, result-line parsing, approval, limits, fairness
  ledger/           JSONL ledger, same format as softfac docs/reference/ledger.md
  tracker/github.ts gh CLI calls (the same argv softfac uses today)
  runner/           start, building, gating, feedback, interruptions
  gate.ts           checkout + provision + gate commands
  pass.ts           one pass: claims, ordering, slots, then advance each run
  config.ts         <base>/factory/config.yml and the repo's .dw/config.yml factory block
  http.ts           /api/factory/status, /runs, /runs/:id, /runs/:id/stop, /claims/pause
apps/web/src/routes/factory.tsx, factory.$runId.tsx
apps/web/src/factory/               page components
factory/                            repo root: SEAMS, sync/build/install scripts, docs
.github/workflows/factory-*.yml     the fork's own CI, sync and release
```

### Seams: the only upstream files we edit

`factory/SEAMS` lists them, and CI fails any change to an upstream file not on the list:

1. `apps/server/src/server.ts`: one line adding `FactoryLayer` to `layerRuntimeCoreDependenciesBase`, and one adding the factory route layer to `layerMakeRoutes`.
2. One nav link in the web sidebar.
3. `apps/web/src/routeTree.gen.ts`: generated, so a merge regenerates it instead of resolving it by hand.

Three entries. Nothing in `ws.ts`, `rpc.ts`, `packages/contracts` or `Migrations.ts`. Those are the files upstream churns most, and adding an RPC would touch five of them. The factory API is a separate HTTP route layer instead.

### Boundary rules, checked by a test

- Only `apps/server/src/factory/t3/**` may import T3 code: files outside `apps/server/src/factory/`, or the workspace packages (`@t3tools/*` and the rest) the server depends on.
- No file outside `factory/` may import from it, except the two lines in `server.ts`.
- The checks run as a vitest test in `apps/server/src/factory/boundary.test.ts`, so they run with the factory suite.

When upstream changes an internal API, the break lands as a type error in `factory/t3/`. Everything above the adapter uses softfac-shaped types (`Launched`, `ThreadStatus`, `Thread`) that we own.

## How the factory runs inside T3

The behaviour is softfac's, as written down in `docs/lifecycle.md` and pinned by `src/runner/tests.rs`. What changes is what sits underneath it.

| softfac today                                                                                | In the fork                                                                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Sessions` trait over HTTP and WebSocket, protocol header, bearer token, websocket ticket    | `factory/t3/sessions.ts` calls services in-process. No token, no ticket, no protocol version.                                          |
| Poll every 60s for thread status                                                             | Still a 60s pass for GitHub, plus `EventSinkV2.stream` wakes a run as soon as its thread's run settles                                 |
| Ledger copies thread id, branch, worktree path and run ordinals                              | The ledger records factory events. Thread facts are read from `ProjectionStoreV2` when needed.                                         |
| `forward-wait`, `gate-sending` and similar steps survive a crash between "send" and "record" | Kept, but simpler: T3's command receipts dedupe a retried `softfac:<run>:…` command id in the same process                             |
| Gate runs as a detached `softfac gate` child that outlives the daemon                        | Gate runs through `process.ts` inside the server. A server restart kills it, and the next pass re-runs the gate from a fresh checkout. |
| `t3 install`, `rollback`, pairing, Open T3 deadline, two LaunchAgents                        | Gone. One binary, versioned as a whole.                                                                                                |
| `status`, `runs list/show/stop`, menubar                                                     | The Factory page and `/api/factory/*`. A small CLI can come later if needed.                                                           |

Kept exactly:

- The `/factory` skill and its last-line protocol (`FACTORY-DONE`, `FACTORY-STOP`). The skill does not know which factory launched it.
- The `factory:*` labels, instructors, `.dw/config.yml` factory block, claims by assignee and label, and comment wording.
- The ledger format. `softfac retro --data-dir <fork base>/factory` then reads the fork's runs with the same code that reads the Rust factory's runs, so the comparison is like for like.

Persistence: JSONL files under `<base>/factory/`, the same layout as `~/.local/share/softfac`. No changes to T3's SQLite and no migrations. If a later version wants factory events in T3's store, that is a separate decision.

## Scope of the experiment (v1)

In:

- One machine (this Mac), one factory identity (the `rawphp` gh login), GitHub issues only.
- Claim, start, building, result line, gate, gate retries, `pr-open` re-gating, feedback relaunch, interruptions, time limits, `needs-info` and `stuck`.
- Factory page: runs, state, current step, last gate output, stop, pause claims.

Out, until the experiment earns them: Linear, multiple identities, fleet API, self-update, menubar, retro step, `repo add` and `user add` wizards, `doctor`. Rust softfac keeps all of these.

## Running both factories side by side

The rule is the one softfac already has: one factory per repo.

- The fork watches only repos that are removed from the Rust factory's `repos` list. Start with one low-stakes repo. Both factories use the same labels, assignee and comment markers, so sharing a repo would make them claim each other's issues.
- Separate everything else:

|              | Rust softfac                                        | Fork                                                         |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| T3 base dir  | `~/.config/softfac/t3`                              | `~/.config/t3fac`                                            |
| Port         | 3874                                                | 3876                                                         |
| LaunchAgent  | `io.github.rawphp.softfac`, `com.rawphp.softfac.t3` | `io.github.rawphp.t3fac`, `io.github.rawphp.t3fac.logrotate` |
| Factory data | `~/.local/share/softfac`                            | `~/.config/t3fac/factory`                                    |
| Repo clones  | `repos[].path`                                      | separate clones, never the same `path`                       |
| Logs         | `~/Library/Logs/softfac`                            | `~/Library/Logs/t3fac`                                       |

`t3fac` is a working name.

## Building the fork ourselves

### Repo and branches

- `original-solutions/t3code-factory`, a public GitHub fork of `pingdotgg/t3code`. `main` is upstream plus our commits. On 2026-10-15 it was identical to upstream `main`, and the factory's `rawphp` login has admin on it.
- Issues and auto-merge are on (set 2026-10-15). Forks start with issues off, the factory works from issues, and green sync PRs need auto-merge.
- Actions are off for the whole repo (set 2026-10-15). GitHub had not registered upstream's 19 workflows yet, so `gh workflow disable` had nothing to act on. Step 1 adds the `factory-*.yml` workflows. In that step, turn Actions back on and run `gh workflow disable` on every upstream workflow straight away, without editing their files, so they stay off the seam list. Upstream's `ci.yml` may run once on that first push.

### Syncing with upstream

We sync to upstream's newest nightly tag, not to the tip of main. A nightly has passed upstream's own quality, test and build jobs.

`factory-sync.yml` runs daily:

1. Find the newest `v*-nightly.*` tag upstream.
2. Merge it into a `sync/<tag>` branch. Use merge, not rebase: our history stays intact and conflicts only show up in the seam files.
3. Regenerate `routeTree.gen.ts`, run the seam check, typecheck `apps/server` and `apps/web`, then run the factory suite and the contract suite.
4. Green: open the PR and auto-merge it.
5. Red: open the PR as a draft and file a `factory:ready` issue on the fork saying what broke. The Rust factory builds it, because the fork is one of the Rust factory's repos (below).

The fork never runs a build that failed its own gates. The installed version only moves when a sync merges and a release builds.

### Contract tests

`apps/server/src/factory/t3/*.contract.test.ts` boot the real orchestration layers with `packages/provider-testing` as the provider. They launch a thread, send a message, wait for `run.updated` to settle, read the last assistant message, archive, and check the worktree is gone. These tests cover only what the adapter uses. They answer one question on every sync: does the adapter still work against this upstream?

### Release build

Local on this Mac. No CI macOS runners, so no cost to the `rawphp` budget. Signing is ad hoc, which is fine on the machine that built it.

`factory/scripts/build.sh`:

1. `vp i`
2. `vp run --filter @t3tools/web build`
3. `cargo build --locked --release` in `native/resource-monitor`
4. `node apps/server/scripts/cli.ts build-exe` with the SEA Node version upstream pins
5. `node scripts/build-cli-archive.ts --platform mac --arch arm64 --version <v> …`
6. Smoke test: `t3 serve` on a throwaway home and base dir, wait for `/.well-known/t3/environment` to answer 200, then check the server log holds `factory started`. It does not call `/api/factory/status`, which needs a paired session (see Decided below).

Version: `<upstream nightly version>+fac.<fork short sha>`, for example `0.0.46-nightly.20261014.2950+fac.1a2b3c4`.

`factory/scripts/install.sh` unpacks the archive into `~/.local/share/t3fac/versions/<version>`, points a `current` symlink at it, and restarts the LaunchAgent. `rollback.sh` points `current` at the previous version. That is the same idea as `softfac t3 install` and `rollback`, as two short scripts.

Not built: npm packages, the desktop app, other platforms, notarisation. A second machine can install from a GitHub Release asset later.

### Fork CI on pull requests

`factory-ci.yml` on an Ubuntu runner: seam check, boundary test, factory unit tests, contract tests, typecheck of server and web. Upstream's own `AGENTS.md` asks agents not to run repo-wide checks, and we don't need them, because the sync job already pins us to tags upstream tested.

## Who builds the fork

The Rust factory builds the fork until the fork's own factory can build its own repo. After that the fork builds itself. Issues `original-solutions/t3code-factory#1` to `#21` take it up to the handover (#21). The handover is a config switch a person makes: the repo leaves the Rust factory's `repos` list and enters the fork's. Issues #22 to #28 (forwarding, re-gating, feedback, interruptions, required checks, the API and the page) stay `factory:proposed` until that switch, and then the fork's factory builds them.

To begin with, `original-solutions/t3code-factory` becomes one of the Rust factory's repos, with a `.dw/config.yml` factory block whose gate is the fork CI commands above. `.dw/` is a new path, so it is not a seam. The work goes in as issues in this order, each one testable on its own:

1. Fork, seams, boundary test, sync job, build and install scripts, an empty `FactoryLayer` that logs "factory started". This proves we can sync and ship before porting anything.
2. Adapter and contract tests.
3. Ledger (format tests ported from `ledger.rs`) and the pure domain (lifecycle, result line, approval, limits).
4. GitHub tracker over `gh`, with argv-matching tests ported from `github.rs`.
5. Pass and claim, then start and building up to the result line.
6. Gate and gate retries, then `pr-open` re-gating and feedback.
7. Interruptions and time limits.
8. Factory page.

Port behaviour, not code. `docs/lifecycle.md` and `src/runner/tests.rs` (836 tests) are the spec. Port the test cases first in each step, then make them pass.

## How we decide

Run the two factories side by side for at least 4 weeks or 30 fork runs, whichever comes later.

Factory output, from `softfac retro` on both data dirs:

- share of runs that reach `pr-open` without a human
- stuck rate, by reason
- time from claim to `pr-open`
- PRs merged without change requests

Cost of the fork:

- sync PRs that went red, and hours spent fixing them
- commits to `factory/t3/` caused by upstream changes
- seam conflicts per month

The fork replaces Rust softfac if its output is at least as good and the sync cost stays under an agreed bound, for example one red sync a week fixed by the factory without Tom. If the sync cost is the problem, the fallback is the cheaper design from the brainstorm: Rust softfac bundled with T3 as one install, still talking over the wire.

## Decided

1. Routes added through `layerMakeRoutes` do not get T3's auth by themselves. `AuthHttp.layerAuthenticatedAuth` is an `HttpApiMiddleware` wired to `EnvironmentHttpApi` endpoints, and its middleware function is typed against HttpApi endpoint metadata, so it cannot wrap a plain `HttpRouter` route. What it does inside is one call, `EnvironmentAuth.authenticateHttpRequest`, and upstream's own plain OTLP trace proxy route (`authenticateRawRouteWithScope` in `apps/server/src/http.ts`) calls that same function and maps its failures with the helpers `auth/http.ts` exports. The factory does the same in `apps/server/src/factory/t3/auth.ts`: `withScope(scope, handler)` authenticates the request through `EnvironmentAuth.authenticateHttpRequest`, provides `EnvironmentAuthenticatedPrincipal`, and checks the scope with `AuthHttp.requireEnvironmentScope`. Paired, relay and tunnel sessions pass through the same code as for `EnvironmentHttpApi`; there is no factory token, no contract change and no RPC. The route layer is `apps/server/src/factory/t3/http.ts` (not `factory/http.ts` as the layout above sketches) because it reads T3's auth, and `server.ts` merges `FactoryRoutes` into `layerMakeRoutes` in one line. Not carried over: the DPoP `WWW-Authenticate` challenge header on a 401, which is private to `auth/http.ts`; upstream's plain routes omit it too. The Factory page will call `/api/factory/*` with the browser session cookie, as it calls T3's HTTP API.

## Open questions to settle in step 1 or 2

2. Answered (#8): `ProcessRunner` spawns through Effect's Node spawner, which does put the child in its own process group (`detached: true` on POSIX) and sends the group `SIGTERM` when the effect is interrupted. It cannot do the rest: it always extends the parent environment (`extendEnv` is true whenever `env` is set), it reads stdout and stderr on separate pipes, and on timeout it drops the partial output and never escalates to `SIGKILL`. `apps/server/src/factory/process.ts` therefore uses `node:child_process` directly, outside `factory/t3/`, and needs no seam.
3. Is a YAML parser already a server dependency? If not, adding one touches `package.json` and the lockfile, so they join the seam list.
4. How does T3 handle a thread's worktree on archive? It leaves it on disk. `thread.archive` cancels the thread's queued runs, detaches its provider sessions, revokes its MCP credential, and closes its terminals and deletes their history (`terminal.cleanup`); the worktree stays. Storage cleanup (Settings → Storage, off by default) only considers active threads, so an archived thread's worktree is never a candidate; only "Delete worktrees with deleted threads" removes one, when the thread is deleted. So the factory removes the worktree itself with git after archiving, as softfac does: `FactorySessions.removeWorktree`, which keeps the branch.
5. Is the installed 0.0.46 nightly already on orchestration v2? The Rust factory works against it with protocol 2, so probably yes. It only affects which upstream tag the first sync starts from.

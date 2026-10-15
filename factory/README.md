# Factory

This is `original-solutions/t3code-factory`, a fork of `pingdotgg/t3code` that runs the software factory inside the T3 server. The design is in [docs/design.md](docs/design.md).

## Seam rule

The only upstream files this fork edits are the ones listed in [SEAMS](SEAMS). [UPSTREAM](UPSTREAM) names the upstream ref and commit the fork is based on. `scripts/check-seams.sh` diffs the committed HEAD against that commit (commit first; staged, unstaged and untracked changes are not checked) and fails on any changed path that is not factory-owned (`apps/server/src/factory/`, `apps/web/src/factory/`, `factory/`, `.dw/`, `apps/web/src/routes/factory*`, `.github/workflows/factory-*`) and not listed in `SEAMS`.

## Boundary rule

Only `apps/server/src/factory/t3/` may import T3 internals. Other files under `apps/server/src/factory/` import relative paths only from inside that folder, and no package that `apps/server/package.json` takes from the workspace (`@t3tools/*`, `effect-acp`, ...). Nothing outside `apps/server/src/factory/` imports the factory, except `apps/server/src/server.ts`. `apps/server/src/factory/boundary.test.ts` enforces both.

## Commands

From the repo root:

```sh
vp test run apps/server/src/factory
vp run --filter t3 typecheck
factory/scripts/check-seams.sh
```

Build, install and roll back the darwin-arm64 binary (LaunchAgent `io.github.rawphp.t3fac`, port 3876):

```sh
factory/scripts/build.sh                      # clean tree only: build, smoke test, then -> release/t3fac-<version>-darwin-arm64.tar.gz
factory/scripts/install.sh <archive>          # unpack, point `current` at it, restart the job
factory/scripts/rollback.sh                   # point `current` at the previous version, restart the job
```

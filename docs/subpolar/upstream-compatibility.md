# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed to `e58a4857130a93cc58b45dd6ebee14cf08df04ec` on 2026-10-16. The fork had 51 commits beyond the shared July base, of which 48 were patch-equivalent to upstream. The remaining three fork commits were replayed on top of the refreshed upstream tip. The direct merge produced widespread conflicts because the fork and upstream histories had been rewritten; the patch-equivalent commits were skipped during replay.

The fork's Docker deployment and image-publish workflow remain as local commits. The old SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client compatibility constraints

This integration has not changed `apps/web`, `apps/desktop`, `apps/mobile`, or T3's client-facing contracts. Subpolar will be exposed only through existing ACP/provider capabilities and server configuration. No Subpolar-specific frontend build or protocol change is planned.

## Validation status

Focused Bun tests pass for the imported Subpolar contracts/runtime/Pi/tools packages, environment coordinator, Docker adapter, and runtime host (97 tests total). ACP bridge tests, recursive typechecks, and the server readiness-route test are present but could not run because workspace dependencies and the Vite+ runner are not installed in this checkout; the pinned package-manager bootstrap also did not complete in the restricted environment. The pnpm lockfile parses as YAML and `git diff --check` passes.

The Docker image, authenticated Docker manager service, persistent environment lifecycle, T3 routing to the adapter, T3 terminal routing, and end-to-end provider flow have not been implemented or validated. The Docker adapter's seven fake-client tests pass, including a linked-worktree mount contract test, but the host has no available Docker daemon for integration testing. ACP tool authorization has a fake-client protocol test; the default CLI still has no configured tool set, and the server does not yet construct a Subpolar gateway. This document does not claim these features are production-ready.


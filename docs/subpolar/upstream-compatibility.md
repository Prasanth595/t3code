# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed to `e58a4857130a93cc58b45dd6ebee14cf08df04ec` on 2026-10-16, then fetched again and merged through `a3e8cf69de` (`upstream/main`, including the new Clerk SDK and orchestration follow-up commits). The fork had 51 commits beyond the shared July base, of which 48 were patch-equivalent to upstream. The remaining three fork commits were replayed on top of the refreshed upstream tip. The direct merge produced widespread conflicts because the fork and upstream histories had been rewritten; the patch-equivalent commits were skipped during replay.

The fork's Docker deployment and image-publish workflow remain as local commits. The old SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client compatibility constraints

This integration has not changed `apps/web`, `apps/desktop`, `apps/mobile`, or T3's client-facing contracts. Subpolar will be exposed only through existing ACP/provider capabilities and server configuration. No Subpolar-specific frontend build or protocol change is planned.

## Validation status

Focused Bun tests pass for the imported Subpolar contracts/runtime/Pi/tools packages, environment coordinator/registration store, Docker adapter, interactive terminal transport/supervisor, Dev Container image discovery, and runtime host (42 environment tests passed in the latest run). ACP bridge tests, recursive typechecks, and T3 server tests could not run because workspace dependencies and the Vite+ runner are not installed in this checkout; the pinned package-manager bootstrap did not complete in the restricted environment. The pnpm lockfile parses as YAML, Compose configuration parses, the worker supervisor passes Node syntax validation, and `git diff --check` passes.

The optional local JSON environment registration store persists lifecycle metadata and reconciles registered resources after manager restart; it does not provide distributed locking or Docker container enumeration. A Docker Engine HTTP client implements container inspection/lifecycle, and its `docker exec` process runner uses the packaged worker supervisor for command execution, streaming, and process-group cancellation. Unit and local worker protocol tests cover this path, but no real Docker container execution has been validated because the host has no available daemon. The authenticated Docker manager service, approved ACP argv execution, explicitly allowlisted T3 terminal routing, and image-based Dev Container discovery now exist. No integrated T3-client or real provider flow has been validated. The Pi harness itself still runs in the ACP bridge process on the gateway; only the approved argv tool and selected terminals run in workers. Dockerfile builds, Features, Compose, lifecycle hooks, preview forwarding, persistent runtime resume, and orphan cleanup are not implemented. ACP tool authorization has a fake-client protocol test; the default CLI still has no configured tool set. This document does not claim these features are production-ready.


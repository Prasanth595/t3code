# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed on 2026-10-16 and merged through `a3e8cf69debae5942798cbe85845de49d6f84066`. `main` contains this upstream tip as an ancestor (`main...upstream/main` is 31 ahead, 0 behind). The upstream additions include the Clerk SDK refresh and orchestration queue-follow-up changes. The local branch retains its Docker deployment and Subpolar integration commits.

The fork's Docker deployment and image-publish workflow remain as local commits. The old SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client compatibility constraints

This integration has not changed `apps/web`, `apps/desktop`, `apps/mobile`, or T3's client-facing contracts. Subpolar will be exposed only through existing ACP/provider capabilities and server configuration. No Subpolar-specific frontend build or protocol change is planned.

## Validation status

Focused Bun tests pass for the imported Subpolar contracts/runtime/Pi/tools packages, environment coordinator/registration store, Docker adapter, interactive TTY and non-TTY process transports/supervisor, Dev Container image discovery, and runtime host (48 environment tests passed in the latest run). The managed ACP proxy/CLI/test bundle passes `bun build`, but its runtime tests could not run because workspace dependencies are not installed (`effect` and the environment manager client are unresolved). Recursive typechecks and T3 server tests could not run because workspace dependencies and the Vite+ runner are missing; the pinned package-manager bootstrap did not complete in the restricted environment. The pnpm lockfile parses as YAML, Compose configuration parses, the worker supervisor passes Node syntax validation, and `git diff --check` passes.

The optional local JSON environment registration store persists lifecycle metadata and reconciles registered resources after manager restart; it does not provide distributed locking or Docker container enumeration. A Docker Engine HTTP client implements container inspection/lifecycle, and its `docker exec` process runner uses the packaged worker supervisor for command execution, streaming, and process-group cancellation. Unit and local worker protocol tests cover this path, but no real Docker container execution has been validated because the host has no available daemon. The authenticated Docker manager service, approved ACP argv execution, managed ACP-to-worker stdio proxy, explicitly allowlisted T3 terminal routing, and image-based Dev Container discovery now exist. No integrated T3-client or real provider flow has been validated. The current worker image does not contain the Subpolar ACP/Pi harness, model credentials, or model-network policy, so the proxy does not establish an isolated Pi run. Dockerfile builds, Features, Compose, lifecycle hooks, preview forwarding, persistent runtime resume, and orphan cleanup are not implemented. ACP tool authorization and transport forwarding have fake-client protocol tests in source, but those tests have not run in this checkout. This document does not claim these features are production-ready.


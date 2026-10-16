# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed on 2026-10-16 to `3b99fb2d2114f57c96bf92e4ed1c7ce5eaa67b1e` and merged by `27dca77d98bb17625d10df6f587e6fb548ab669f`. The upstream tip is an ancestor of the current `main`; the current branch is not behind that reference. This merge includes upstream's Expo patch and workspace/lockfile updates, as well as the previously merged Clerk SDK refresh and orchestration queue-follow-up changes. Local Docker deployment and Subpolar integration commits remain on the branch.

The older SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client and provider compatibility

The current Subpolar changes do not modify `apps/web`, `apps/desktop`, `apps/mobile`, or `packages/contracts` compared with the fetched upstream tip. They add no client RPC methods or event schemas. T3 remains the owner of the client protocol and orchestration. The Subpolar ACP bridge is configured as an existing local ACP executable; no new provider kind is registered. T3's native Pi provider remains separate and available.

This source-level compatibility check does not prove the clients work against an integrated Subpolar runtime. No integrated T3-client flow, real ACP Pi turn, or full provider regression pass has been validated. ACP configuration is server-side and operator supplied; no Subpolar-specific frontend build is needed.

## Validation status and limitations

The following focused checks have passed in the current checkout:

- Latest focused Bun verification passed: 89 tests and 331 assertions across 14 files, covering the environment manager and Docker backend, admin routes and CLI, process/terminal supervision, Pi runtime persistence, ACP warm/cold resume, and capability reporting.
- The broader ACP package run reported 27 passing tests, but `agent.test.ts` could not load because Bun could not import the Vitest-only `assert` export from `@effect/vitest`.
- Frozen offline pnpm lockfile validation succeeded across all 40 workspace projects.
- The Subpolar ACP CLI bundles with Bun (254 modules) without the removed Effect API warning. This does not verify Docker image creation or a real worker run.

Typechecking and T3 server tests could not run in the filtered dependency environment: platform-specific `tsc-rs` and TypeScript 7 packages were absent, as was the Vite+ native test runner binding. Installing optional dependencies did not complete in the restricted environment. No Docker daemon was available, so there has been no real Docker container execution or gateway/Compose smoke test.

The authenticated Docker manager and `subpolar` admin CLI, approved ACP argv execution, managed ACP-to-worker stdio proxy, explicitly allowlisted T3 terminal routing, image-based Dev Container discovery, and constrained Dockerfile builds exist in source. Registered environment reconciliation now observes verified running or stopped state without starting containers and reports missing containers while preserving their registrations. Runtime-host persistence capabilities are only advertised when the selected Pi executor explicitly supports persisted sessions and has an absolute runtime data directory; relative data-directory settings fail before session creation. A manager-owned named volume now preserves Pi agent configuration across container rebuilds, with lifecycle handling for exact legacy containers and missing-volume recovery. Managed-worker Pi conversation sessions now resume after an ACP worker restart when the manager-owned runtime volume survives: session IDs are hashed, and load/resume validates both the saved Pi session ID and cwd. T3 remains authoritative for thread history; the runtime does not persist run outcomes or replay events. An opt-in, session-bound ACP credential bridge backs Pi's worker-local CredentialStore with the configured T3 provider instance and a server-side provider allowlist; a T3 masked sign-in interaction seeds the initial credential into that encrypted instance store. The broker's same-process write lock cannot coordinate separate T3 server processes. Local protocol and fake-client tests cover portions of these paths, but they do not establish end-to-end isolation. The worker image now bundles the Subpolar ACP/Pi runtime, but there is no restricted model API egress path. Provider egress remains disabled because the manager cannot enforce Docker-host firewall policy; a private Docker network alone is not a sufficient boundary. The current code does not complete a real managed Pi turn or provide isolated model-provider access. Features, Compose Dev Container support, lifecycle hooks, preview forwarding, distributed manager locking, orphan cleanup, and full shutdown recovery remain unimplemented or unverified. The manager's local registration file is not a distributed coordination mechanism.

The code and focused package checks establish an upstream-compatible integration seam, not completion of the integration acceptance criteria. See [the architecture](architecture.md) and [migration matrix](migration-matrix.md) for ownership boundaries and retained/deferred source functionality.

# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed on 2026-10-16 to `a3e8cf69debae5942798cbe85845de49d6f84066` and merged by `c384ee07038800a5adf69bab0bac0580d29c0113`. The upstream tip is an ancestor of the current `main`; the current branch is not behind that reference. This merge includes upstream's Clerk SDK refresh and orchestration queue-follow-up changes. Local Docker deployment and Subpolar integration commits remain on the branch.

The older SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client and provider compatibility

The current Subpolar changes do not modify `apps/web`, `apps/desktop`, `apps/mobile`, or `packages/contracts` compared with the fetched upstream tip. They add no client RPC methods or event schemas. T3 remains the owner of the client protocol and orchestration. The Subpolar ACP bridge is configured as an existing local ACP executable; no new provider kind is registered. T3's native Pi provider remains separate and available.

This source-level compatibility check does not prove the clients work against an integrated Subpolar runtime. No integrated T3-client flow, real ACP Pi turn, or full provider regression pass has been validated. ACP configuration is server-side and operator supplied; no Subpolar-specific frontend build is needed.

## Validation status and limitations

The following focused checks have passed in the current checkout:

- Bun tests for the Pi adapter, runtime host, managed ACP proxy, and worker execution passed in the focused run.
- The broader ACP package run reported 27 passing tests, but `agent.test.ts` could not load because Bun could not import the Vitest-only `assert` export from `@effect/vitest`.
- Frozen offline pnpm lockfile validation succeeded across all 40 workspace projects.
- Managed proxy and CLI sources build with Bun. This build does not verify that their runtime dependencies are installed or that a real worker can run them.

Typechecking and T3 server tests could not run in the filtered dependency environment: platform-specific `tsc-rs` and TypeScript 7 packages were absent, as was the Vite+ native test runner binding. Installing optional dependencies did not complete in the restricted environment. No Docker daemon was available, so there has been no real Docker container execution or gateway/Compose smoke test.

The authenticated Docker manager, approved ACP argv execution, managed ACP-to-worker stdio proxy, explicitly allowlisted T3 terminal routing, and image-based Dev Container discovery exist in source. Local protocol and fake-client tests cover portions of those paths, but they do not establish end-to-end isolation. The worker image contains process supervisors only: it does not include the Subpolar ACP/Pi harness, Pi credentials, a model credential broker, or model API egress policy. The current code does not complete a real managed Pi turn or provide isolated model-provider access. Dockerfile builds, Features, Compose Dev Container support, lifecycle hooks, preview forwarding, persistent runtime resume, distributed manager locking, orphan cleanup, and full shutdown recovery remain unimplemented or unverified. The manager's local registration file is not a distributed coordination mechanism.

The code and focused package checks establish an upstream-compatible integration seam, not completion of the integration acceptance criteria. See [the architecture](architecture.md) and [migration matrix](migration-matrix.md) for ownership boundaries and retained/deferred source functionality.

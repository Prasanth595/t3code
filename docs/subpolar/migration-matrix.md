# Subpolar migration matrix

Source: Subpolar commit `2ddbce8` (`automations`, 2026-10-11). This matrix records the current migration decision, not a claim of production readiness.

| Source area | Decision | Reason / follow-up |
| --- | --- | --- |
| `subpolar-contracts` (`@subpolar/shared`) | Import first | Runtime contracts and schemas are useful; package also contains executable Skills logic that must not be confused with T3's schema-only `packages/contracts`. |
| `subpolar-core` (`@subpolar/runtime`) | Import first | Runtime composition, policy and approval gateway; stateless with respect to T3 threads. |
| `subpolar-core-pi` (`@subpolar/runtime-pi`) | Import first | Transient Pi adapter. Its dynamically loaded Pi SDK is declared as an optional peer; the host supplies installation and credentials. |
| `subpolar-tools` (`@subpolar/tools`) | Import first | Persistence-neutral tool registry and CLI surface. |
| `subpolar-runtime-host` (`@subpolar/runtime-host`) | Add initial host | Owns ephemeral Pi sessions and cancellation in one process; no persistence/resume, tools, or environment isolation. |
| `subpolar-acp` (`@subpolar/acp`) | Import initial bridge and expose its executable to the T3 workspace | Uses T3's existing local ACP command path. When manager URL, token, and storage root are set in the T3 server environment, it exposes a managed argv tool through the authenticated manager client and asks T3 for one-time permission per call. The bridge and Pi SDK still run on the T3 host; only this tool executes in the managed environment. |
| `subpolar-environments` (`@subpolar/environments`) | Import lifecycle and Docker adapter | Stable identity, path containment, same-process lifecycle coordinator, optional local registration store and restart reconciliation, authenticated HTTP handler/server factory/client, Docker Engine lifecycle client, worker-supervised argv execution, safe container settings, and worktree-bounded process cwd. The adapter can map linked Git metadata when explicitly configured; T3 does not yet configure or use the manager API. No cross-process transaction/lock, Docker container enumeration, or orphan cleanup. |
| `subpolar-operations` (`@subpolar/shared-operations`) | Defer | Source/tests import undeclared `@subpolar/contracts`; repair package identity and tests before migration. |
| `subpolar-persistance-local` (`@subpolar/db-local`) | Defer | Session and runtime persistence must not become a second authority for T3 threads/events. |
| `subpolar-persistance-pocketbase` (`@subpolar/db`) | Defer | PocketBase dependency is undeclared; requires an explicit persistence adapter boundary. |
| `subpolar-automations` | Defer | Separate automation lifecycle and stores need ownership and server integration design. |
| `subpolar-browser` | Defer | Playwright worker and network policy require environment isolation and lifecycle integration. |
| `subpolar-cli` | Defer | Depends on local persistence and Pi; administration commands need a supported T3 configuration model. |
| `subpolar-test-cli` | Defer | Test utility; migrate with the CLI or a future package test harness. |
| `subpolar-client` | Exclude | Tied to Subpolar's old frontend; no second frontend or client protocol is allowed. |
| `external-agents-adapter` | Defer | Exploratory OpenCode/MCP runtime overlaps the intended ACP integration and includes Bun-specific hosting. |
| `@subpolar-agent/server` | Do not import wholesale | Backend mixes profiles, runtime, PocketBase, tools, Git/worktrees, memory, voice, and old API/UI concerns; extract only after ownership review. |
| T3 Git/worktrees/checkpoints/threads | Retain T3 ownership | Reuse T3 worktree paths and lifecycle; do not duplicate them in Subpolar. |

## Package-management notes

T3's `packages/*` pnpm workspace glob includes imported packages. Keep Subpolar's package names and valid `workspace:*` dependencies. Bun remains a test/runtime requirement for imported Subpolar package tests; CI installs the pinned Bun runtime in the test job while pnpm remains the sole workspace package manager and lockfile. Imported source packages now expose focused `typecheck` scripts through T3's recursive TypeScript check.


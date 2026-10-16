# Subpolar migration matrix

Source: Subpolar commit `2ddbce8` (`automations`, 2026-10-11). This matrix records the current migration decision, not a claim of production readiness.

| Source area | Decision | Reason / follow-up |
| --- | --- | --- |
| `subpolar-contracts` (`@subpolar/shared`) | Import first | Runtime contracts and schemas are useful; package also contains executable Skills logic that must not be confused with T3's schema-only `packages/contracts`. |
| `subpolar-core` (`@subpolar/runtime`) | Import first | Runtime composition, policy and approval gateway; stateless with respect to T3 threads. |
| `subpolar-core-pi` (`@subpolar/runtime-pi`) | Import first | Transient Pi adapter. Its dynamically loaded Pi SDK is declared as an optional peer; the host supplies installation and credentials. |
| `subpolar-tools` (`@subpolar/tools`) | Import first | Persistence-neutral tool registry and CLI surface. |
| `subpolar-acp` (`@subpolar/acp`) | Import initial bridge | Uses T3's existing ACP provider path; current bridge is prompt/response text only with Pi tools disabled. |
| `subpolar-environments` (`@subpolar/environments`) | Import initial contract | Backend-neutral stable identity, path containment, and lifecycle coordinator; no Docker driver or durable manager yet. |
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

T3's `packages/*` pnpm workspace glob includes imported packages. Keep Subpolar's package names and valid `workspace:*` dependencies. Bun may remain a runtime for Subpolar-specific workers and tests, but pnpm remains the sole workspace package manager and lockfile. Several source packages use Bun test scripts/APIs; those tests need focused migration or an explicitly retained Bun test runtime before they are treated as supported under T3.


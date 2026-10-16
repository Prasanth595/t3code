# Subpolar migration matrix

Source: Subpolar commit `2ddbce819d4a364de075f5d2541eeecb37ac00e8` (`automations`, 2026-10-11). The source checkout has no root license file and its package manifests do not declare a license; provenance is recorded, but redistribution rights remain unverified. This matrix records the current migration decision, not a claim of production readiness.

| Source area | Decision | Reason / follow-up |
| --- | --- | --- |
| `subpolar-contracts` (`@subpolar/shared`) | Import first | Runtime contracts and schemas are useful; package also contains executable Skills logic that must not be confused with T3's schema-only `packages/contracts`. |
| `subpolar-core` (`@subpolar/runtime`) | Import first | Runtime composition, policy and approval gateway; stateless with respect to T3 threads. |
| `subpolar-core-pi` (`@subpolar/runtime-pi`) | Import first | Transient Pi adapter. Its dynamically loaded Pi SDK is declared as an optional peer; the host supplies installation and credentials. |
| `subpolar-tools` (`@subpolar/tools`) | Import first | Persistence-neutral tool registry and CLI surface. |
| `subpolar-runtime-host` (`@subpolar/runtime-host`) | Add initial host | Owns ephemeral Pi sessions and cancellation in one process; no persistence/resume, tools, or environment isolation. |
| `subpolar-acp` (`@subpolar/acp`) | Import the bridge and expose it through T3's existing ACP command path | Local execution remains the default. With manager URL, token, and storage root configured, local mode exposes one argv tool through the authenticated manager client and requests T3's one-time permission per call. Explicit `SUBPOLAR_ACP_EXECUTION=managed` instead proxies ACP over authenticated non-TTY worker sessions and fails closed on startup errors. The configured worker command is a JSON argv list. ACP session IDs are preserved. Worker-only mode exposes an approved, worktree-bounded argv tool with output limits, cancellation, and no manager credentials. The bridge/runtime-host/Pi SDK still run on the T3 host in local mode; managed mode requires a worker executable already present in the image. The current worker image lacks the Subpolar ACP/Pi harness, Pi credentials, and a model-network policy. Runtime persistence/resume remains unimplemented. |
| `subpolar-environments` (`@subpolar/environments`) | Import lifecycle and Docker adapter | Stable identity, path containment, same-process lifecycle coordinator, optional local registration store and restart reconciliation, authenticated HTTP handler/server factory/client, `subpolar-manager` CLI, Docker Engine lifecycle client, worker-supervised argv execution, interactive TTY sessions, authenticated non-TTY bidirectional process sessions, safe container settings, and worktree-bounded process cwd. The opt-in Compose profile provides the manager; T3's ACP bridge can use its execution API when configured, and T3 terminals can be routed to workers for explicitly allowlisted provider instance IDs. Image-based Dev Container configuration is supported with a strict subset. No cross-process transaction/lock, Docker container enumeration, orphan cleanup, or preview forwarding yet. |
| `subpolar-operations` (`@subpolar/shared-operations`) | Defer | Source/tests import undeclared `@subpolar/contracts`; repair package identity and tests before migration. |
| `subpolar-persistance-local` (`@subpolar/db-local`) | Defer | Session and runtime persistence must not become a second authority for T3 threads/events. |
| `subpolar-persistance-pocketbase` (`@subpolar/db`) | Defer | PocketBase dependency is undeclared; requires an explicit persistence adapter boundary. |
| `subpolar-automations` | Defer | Separate automation lifecycle and stores need ownership and server integration design. |
| `subpolar-browser` | Defer | Source package is repository-context browsing, not general website automation; it needs an isolation boundary and has an open Chromium lifecycle leak in the source audit. |
| `subpolar-cli` | Defer | Depends on local persistence and Pi; administration commands need a supported T3 configuration model. |
| `subpolar-test-cli` | Defer | Test utility; migrate with the CLI or a future package test harness. |
| `subpolar-client` | Exclude | Tied to Subpolar's old frontend; no second frontend or client protocol is allowed. |
| `external-agents-adapter` | Defer | Exploratory OpenCode/MCP runtime overlaps the intended ACP integration and includes Bun-specific hosting. |
| `@subpolar-agent/server` | Do not import wholesale | Backend mixes profiles, runtime, PocketBase, tools, Git/worktrees, memory, voice, and old API/UI concerns; extract only after ownership review. |
| Backend agent profiles and runtime configuration | Extract/adapt | Profiles, model/provider settings, and runtime mappings live in the app backend. Map them to T3 ACP configuration and Subpolar runtime config without creating a second project/thread store. |
| Backend OpenAPI tool generation | Extract/adapt | Tool generation is reusable backend logic; route it through Subpolar's tool registry and explicit approval policy before exposing it to a runtime. |
| Backend MCP discovery and adapters | Defer/adapt | Some registry and HTTP tool routing exists; MCP management CRUD remains incomplete. Keep authorization and credentials runtime-scoped. |
| Backend approvals, denials, and audit | Extract/adapt | Reuse policy logic only after verifying that denial, revocation, and replacement behavior fail closed; the source audit found a fail-open window during tool-policy replacement. |
| Backend memory, skills, and subagent control | Defer/extract | Extract service logic only with a T3-owned thread/worktree binding and explicit runtime state boundary. Do not import old routes or session ownership. |
| Backend credentials and provider login | Defer/adapt | Do not migrate secrets through plaintext or indiscriminately pass T3 credentials into workers; define a scoped credential and egress policy first. |
| Backend GitHub/Gitea repository context | Defer/adapt | Read-only repository context browsing is distinct from T3's authoritative Git, worktree, checkpoint, and review lifecycle. |
| Backend SSH, automations, inbox, and notifications | Defer | SSH/remote repo management is absent or incomplete; Subpolar automations and notification lifecycle overlap with T3 and need explicit ownership. |
| Backend voice and speech services | Defer | Source audit found no complete TTS/STT implementation to migrate. |
| T3 Git/worktrees/checkpoints/threads | Retain T3 ownership | Reuse T3 worktree paths and lifecycle; do not duplicate them in Subpolar. |

## Package-management notes

T3's `packages/*` pnpm workspace glob includes imported packages. Keep Subpolar's package names and valid `workspace:*` dependencies. Bun remains a test/runtime requirement for imported Subpolar package tests; CI installs the pinned Bun runtime in the test job while pnpm remains the sole workspace package manager and lockfile. Imported source packages now expose focused `typecheck` scripts through T3's recursive TypeScript check.


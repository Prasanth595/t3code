# ZeroClaw Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a T3 Code provider for the ZeroClaw daemon that lets T3's web, desktop, and mobile clients drive ZeroClaw agents over the daemon's native JSON-RPC 2.0 protocol over a Unix socket / named pipe.

**Architecture:** A new `@t3tools/provider-zeroclaw` workspace package mirroring `provider-pi`'s structure: settings schema, client definition, server entry, and a server directory containing the RPC transport layer, protocol type decoders, the V2 adapter (mapping ZeroClaw `session/*` RPC calls to T3's `ProviderAdapterV2` interface), subagent projection helpers, and the driver. The adapter connects to the daemon's NDJSON socket, sends `initialize`, then maps `session/new`, `session/prompt`, `session/steer`, `session/cancel`, `session/approve`, `session/messages`, and `session/close` to T3 thread/turn lifecycle operations. Event notifications (`session/update`) are projected into T3 turn items, subagent cards, approvals, and todo lists. The driver is registered in `builtInDrivers.ts`, `providerStatusCache.ts`, `model-manifest.json`, `contracts/model.ts`, and the web/mobile client registries.

**Tech Stack:** TypeScript, Effect (Schema, Effect, Queue, Stream, Deferred), `node:net` for socket transport, pnpm workspace, vitest for tests.

---

## File Map

### New files (all under `packages/provider-zeroclaw/`)

| File | Responsibility |
|---|---|
| `package.json` | Package manifest, exports, deps |
| `tsconfig.json` | Extends base config |
| `src/settings.ts` | `ZeroClawSettings` schema |
| `src/client.ts` | `zeroClawClient` definition |
| `src/server.ts` | Re-exports driver + adapter |
| `src/testing.ts` | Testing helpers (empty stub, like provider-grok) |
| `src/server/rpc.ts` | NDJSON JSON-RPC 2.0 transport over `node:net` |
| `src/server/rpc.test.ts` | RPC layer unit tests |
| `src/server/protocol.ts` | Effect Schema decoders for RPC types |
| `src/server/protocol.test.ts` | Protocol decoder tests |
| `src/server/projection.ts` | Pure `sessionUpdateToEvents` mapping function |
| `src/server/projection.test.ts` | Event mapping tests |
| `src/server/subagents.ts` | Subagent detection helpers |
| `src/server/subagents.test.ts` | Subagent helper tests |
| `src/server/adapter.ts` | `makeZeroClawAdapterV2` — the V2 adapter |
| `src/server/adapter.test.ts` | Adapter agent-mismatch + model-switch tests |
| `src/server/driver.ts` | `ZeroClawDriver` — snapshot, maintenance, registration |
| `src/server/driver.test.ts` | Driver snapshot tests |

### Modified files

| File | Change |
|---|---|
| `apps/server/package.json` | Add `@t3tools/provider-zeroclaw: workspace:*` |
| `apps/web/package.json` | Add `@t3tools/provider-zeroclaw: workspace:*` |
| `apps/mobile/package.json` | Add `@t3tools/provider-zeroclaw: workspace:*` |
| `package.json` (root) | Add `--workspace packages/provider-zeroclaw` to `knip:check` |
| `apps/server/src/provider/builtInDrivers.ts` | Import + append `ZeroClawDriver`, extend `BuiltInDriversEnv` |
| `apps/server/src/provider/providerStatusCache.ts` | Append `"zeroclaw"` to `BUILT_IN_DRIVER_ORDER` |
| `apps/server/src/provider/model-manifest.json` | Add zeroclaw compatibility entry, bump `updatedAt` |
| `packages/contracts/src/model.ts` | Add `DEFAULT_MODEL_BY_PROVIDER["zeroclaw"] = "default"` and `PROVIDER_DISPLAY_NAMES["zeroclaw"] = "ZeroClaw"` |
| `apps/web/src/components/settings/providerDriverMeta.ts` | Add `zeroClawClient` |
| `apps/mobile/src/lib/providerClients.ts` | Add `zeroClawClient` |
| `docs/user/install.md` | Add ZeroClaw row to providers table |
| `docs/user/providers-zeroclaw.md` | New provider docs |

---

## Phases

### Phase 0 — Scaffold

- [ ] **Step 1: Create `packages/provider-zeroclaw/package.json`**

```json
{
  "name": "@t3tools/provider-zeroclaw",
  "private": true,
  "type": "module",
  "exports": {
    "./client": { "types": "./src/client.ts", "import": "./src/client.ts" },
    "./settings": { "types": "./src/settings.ts", "import": "./src/settings.ts" },
    "./server": { "types": "./src/server.ts", "import": "./src/server.ts" },
    "./testing": { "types": "./src/testing.ts", "import": "./src/testing.ts" }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vp test run --config ../../vite.config.ts --dir ."
  },
  "dependencies": {
    "@t3tools/contracts": "workspace:*",
    "@t3tools/provider-core": "workspace:*",
    "@t3tools/shared": "workspace:*",
    "effect": "catalog:"
  },
  "devDependencies": {
    "@effect/platform-node": "catalog:",
    "@effect/vitest": "catalog:",
    "@t3tools/provider-testing": "workspace:*",
    "@types/node": "catalog:",
    "vite-plus": "catalog:"
  }
}
```

- [ ] **Step 2: Create `packages/provider-zeroclaw/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Create empty source modules**

`src/settings.ts`, `src/client.ts`, `src/server.ts`, `src/testing.ts` — each with a minimal export so typecheck passes.

`src/settings.ts`:
```ts
import { makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZeroClawSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    socketPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Daemon socket",
        description: "Path to the ZeroClaw daemon socket. Empty uses ZEROCLAW_SOCKET, then the default data directory.",
        providerSettingsForm: { placeholder: "/home/me/.zeroclaw/data/daemon.sock", clearWhenEmpty: "omit" },
      }),
    ),
    defaultAgentAlias: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default agent",
        description: "Agent alias used when a thread does not select one.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["socketPath", "defaultAgentAlias"] },
);
export type ZeroClawSettings = typeof ZeroClawSettings.Type;
```

`src/client.ts`:
```ts
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { ZeroClawSettings } from "./settings.ts";

export const zeroClawClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zeroclaw"),
  label: "ZeroClaw",
  settingsSchema: ZeroClawSettings,
});
```

`src/server.ts`:
```ts
export { ZeroClawDriver, type ZeroClawDriverEnv } from "./server/driver.ts";
export { ZeroClawAdapterV2Driver, type ZeroClawAdapterV2DriverEnv } from "./server/adapter.ts";
```

`src/testing.ts`:
```ts
// Testing helpers — stub for now, populated as tests need them.
export {};
```

- [ ] **Step 4: Register workspace package in app package.jsons**

Add `"@t3tools/provider-zeroclaw": "workspace:*"` to `apps/server/package.json`, `apps/web/package.json`, `apps/mobile/package.json`.

- [ ] **Step 5: Add to root knip:check**

Add `--workspace packages/provider-zeroclaw` to the `knip:check` script in root `package.json`.

- [ ] **Step 6: Verify**

Run `vp i` (pnpm install) and `vp run typecheck` — should pass with empty modules.

---

### Phase 1 — RPC Transport

- [ ] **Step 1: Write `src/server/rpc.ts`**

Exports:
- `ZeroClawRpcError` — tagged error for connection/protocol failures
- `ZeroClawRpcTimeoutError` — tagged error for request timeouts
- `ZeroClawRpcConnection` interface with `request`, `notify`, `events` (Queue), `inboundRequests` (Queue), `respond`, `closed`, `terminate`
- `makeZeroClawRpcConnection(options)` — Effect that creates a `node:net` socket connection

Key behavior:
1. `NodeNet.createConnection({ path })` — connect to Unix socket or named pipe
2. NDJSON framer: split on `\n`, strip trailing `\r`, cap buffered line at 8 MiB
3. Route frames: response (has `id` + `result`/`error`) → resolve pending; inbound request (has `method` + `id`) → push to `inboundRequests`; notification (has `method`, no `id`) → push to `events`; malformed → log debug, drop
4. Outbound request ids use `t3-out-<n>` sequence
5. Pending requests stored in `Map<string, Deferred>`
6. Default 30s timeout, overridable per call
7. Scope finalizer destroys socket on exit

- [ ] **Step 2: Write `src/server/rpc.test.ts`**

Tests against a fake daemon on a real Unix socket in a temp dir:
- Handshake: connect + send `initialize` + receive response
- Correlation: request id matches response
- Notification routing: notification goes to `events` queue
- Inbound request round-trip: daemon sends request, client responds
- Oversized frame refusal: >8 MiB line fails connection
- Mid-request disconnect: pending requests fail with `ZeroClawRpcError`

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/rpc.test.ts` — all tests pass.

---

### Phase 2 — Protocol Types

- [ ] **Step 1: Write `src/server/protocol.ts`**

Effect Schema decoders for the RPC subset:
- `InitializeResult` — `{ protocolVersion: number }`
- `StatusResult` — `{ version: string, ... }`
- `AgentsListResult` — `{ agents: Array<{ alias: string, name: string }> }`
- `SessionNewResult` — `{ sessionId: string }`
- `SessionPromptResult` — `{ outcome: string }`
- `SessionStateResult` — `{ sessionId: string, ... }`
- `SessionMessagesResult` — `{ messages: Array<unknown> }`
- `SessionUpdate` — union with catch-all `{ type: string }` member
- `ApprovalRequestUpdate` — `{ type: "approval_request", request_id, tool_name, arguments_summary, timeout_secs }`
- `TurnCompleteUpdate` — `{ type: "turn_complete", outcome }`
- `SessionOverrides` — `{ model?, model_provider?, temperature? }`

Decode leniently: unknown `session/update` types must be ignorable.

- [ ] **Step 2: Write `src/server/protocol.test.ts`**

Decode one recorded frame per type plus an unknown type — all decode without error.

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/protocol.test.ts` — all tests pass.

---

### Phase 3 — Subagent Helpers

- [ ] **Step 1: Write `src/server/subagents.ts`**

Pure helpers:
- `subagentCallFromToolCall(name, rawInput)` → `{ prompt, title, agents } | null`
  - Returns `null` for `background: true` delegate
  - Returns `null` for `delegate` with `action !== "delegate"`
  - Returns `null` for empty prompt
  - For `spawn_subagent`: extract `prompt`, derive `title` from prompt, `agents` from `agents` array
  - For `delegate` with `parallel: [...]`: one subagent per tool call, title lists all agents
- `subagentOutcomeFromToolResult(rawOutput)` → `{ status, result }`

- [ ] **Step 2: Write `src/server/subagents.test.ts`**

- Foreground `spawn_subagent` creates one subagent
- Background `delegate` creates none
- Parallel `delegate` creates one with all agents in title
- Result settles subagent (completed/failed)

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/subagents.test.ts` — all tests pass.

---

### Phase 4 — Event Projection

- [ ] **Step 1: Write `src/server/projection.ts`**

Pure function `sessionUpdateToEvents(state, update)` that maps each `session/update` type to T3 projection events:

| `session/update` type | T3 projection |
|---|---|
| `agent_message_chunk` | `turn_item.updated` (assistant_message, streaming, coalesced) |
| `agent_thought_chunk` | `turn_item.updated` (reasoning, streaming) |
| `tool_call` | `node.updated` (running) + `turn_item.updated` (dynamic_tool) |
| `tool_result` | `node.updated` (completed/failed) + `turn_item.updated` (output) |
| `approval_request` | `runtime_request.updated` + `turn_item.updated` (approval_request) |
| `plan` | `plan.updated` (todo_list) |
| `context_usage` | `provider_turn.updated` (contextUsage) |
| `history_trimmed` | `turn_item.updated` (system_notice) |
| `budget_warning` | `turn_item.updated` (system_notice) |
| `turn_complete` | `turn.terminal` |
| unknown | ignored (no event emitted) |

Text coalescing: accumulate `agent_message_chunk` into a buffer, flush on 50ms interval or `turn_complete`.

Subagent integration: qualifying `tool_call` emits `subagent.updated` (running) + `app_thread.created` (child thread); matching `tool_result` emits `subagent.updated` (completed/failed).

- [ ] **Step 2: Write `src/server/projection.test.ts`**

Cover every row of the event table plus unknown types being ignored.

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/projection.test.ts` — all tests pass.

---

### Phase 5 — Adapter

- [ ] **Step 1: Write `src/server/adapter.ts`**

`makeZeroClawAdapterV2(options)` returning `ProviderAdapter.ProviderAdapterV2.of({...})`.

Structure:
- `openSession` — resolve socket path, connect via `makeZeroClawRpcConnection`, send `initialize`, build session entity, return runtime
- Per-thread state map keyed by ZeroClaw `sessionId`: `{ providerThread, activeTurn, appliedModel, appliedAgent, items: Map<toolCallId, itemId>, subagents: Map<toolCallId, subagent> }`
- Single notification pump fiber reads `connection.events`, dispatches by `session_id`
- `emit(event)` pushes to session `Queue`; `events: Stream.fromQueue(events)`

Methods:
- `getCapabilities` — constant from design doc
- `planSelectionTransition` — `turnScopedSelectionTransition()`
- `ensureThread` — `session/new` with `agent_alias`, `cwd`, `keep_siblings: true`
- `resumeThread` — `session/new` with existing `session_id`
- `startTurn` — agent check → model check → `session/prompt`
- `steerTurn` — `session/steer`
- `interruptTurn` — `session/cancel`
- `respondToRuntimeRequest` — `session/approve` for approvals; `respond` for elicitation
- `readThreadSnapshot` — `session/messages` → conversation messages
- `unloadThread` — `session/close`
- `rollbackThread` / `forkThread` — fail with `ProviderAdapterProtocolError`
- `hasPendingBackgroundWork` — `false`

Turn start order:
1. Resolve agent from `modelSelection.options` (`id: "agent"`), fallback to `settings.defaultAgentAlias`, then session's agent
2. If differs from session's agent → fail with documented message
3. If model differs from `appliedModel`:
   - `default` with no override → skip `session/configure`
   - `default` with override → fail with documented message
   - otherwise → `session/configure` with `{ model, model_provider }` split at first `/`
4. Emit `provider_turn.updated` (running), then `session/prompt`

- [ ] **Step 2: Write `src/server/adapter.test.ts`**

Cover agent-mismatch and model-switch paths against a fake daemon.

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/adapter.test.ts` — all tests pass.

---

### Phase 6 — Driver

- [ ] **Step 1: Write `src/server/driver.ts`**

`ZeroClawDriver: ProviderDriver<ZeroClawSettings, ZeroClawDriverEnv>`.

- `metadata: { displayName: "ZeroClaw", supportsMultipleInstances: true }`
- `create` builds adapter, `makeManagedServerProvider` snapshot, unsupported `ProviderTextGeneration`
- Snapshot probe: connect, `initialize`, `status`, `agents/list`, `config/catalog` + `config/catalog-models` per provider (15 min cache). Never open a session. Report `installed: false` with actionable message when socket missing.
- `snapshotForCwd` returns `agent` option descriptor from `agents/list`
- Maintenance: manual only (`makeManualOnlyProviderMaintenanceCapabilities`)

- [ ] **Step 2: Write `src/server/driver.test.ts`**

Fake daemon yields ready snapshot with models and agent descriptor; missing socket yields warning snapshot, not thrown defect.

- [ ] **Step 3: Verify**

Run `vp test run --dir packages/provider-zeroclaw/src/server/driver.test.ts` — all tests pass.

---

### Phase 7 — Registration

- [ ] **Step 1: Register in `apps/server/src/provider/builtInDrivers.ts`**

Import `ZeroClawDriver` and `ZeroClawDriverEnv`, append to `BUILT_IN_DRIVERS`, extend `BuiltInDriversEnv`.

- [ ] **Step 2: Register in `apps/server/src/provider/providerStatusCache.ts`**

Append `"zeroclaw"` to `BUILT_IN_DRIVER_ORDER`.

- [ ] **Step 3: Add to `apps/server/src/provider/model-manifest.json`**

Add zeroclaw compatibility entry with `t3CodeRange: ">=0.0.44"` and a `ranges` list keyed on daemon version. Bump `updatedAt`.

- [ ] **Step 4: Add to `packages/contracts/src/model.ts`**

```ts
[ProviderDriverKind.make("zeroclaw")]: "default",
```
in `DEFAULT_MODEL_BY_PROVIDER`, and:
```ts
[ProviderDriverKind.make("zeroclaw")]: "ZeroClaw",
```
in `PROVIDER_DISPLAY_NAMES`.

- [ ] **Step 5: Register in `apps/web/src/components/settings/providerDriverMeta.ts`**

Add `zeroClawClient` import and entry.

- [ ] **Step 6: Register in `apps/mobile/src/lib/providerClients.ts`**

Add `zeroClawClient` import and entry.

- [ ] **Step 7: Verify**

Run `vp run typecheck` — passes. Provider appears in Add provider on web and mobile, disabled by default.

---

### Phase 8 — Docs

- [ ] **Step 1: Write `docs/user/providers-zeroclaw.md`**

Setup, socket path, agent selection, model switching, agent-per-thread rule, note about ZeroClaw's autonomy config deciding which tools prompt.

- [ ] **Step 2: Add row to `docs/user/install.md` providers table**

```
| ZeroClaw     | Install [ZeroClaw](https://zeroclaw.dev), start `zeroclaw daemon`, then enable it in Settings → Providers. |
```

- [ ] **Step 3: Verify**

Run `vp run check:changed` — passes.

---

### Phase 9 — Live Verification (manual)

Against a real daemon:
1. Start `zeroclaw daemon` with two configured agents
2. Enable the provider, confirm snapshot lists both agents and model catalog
3. Run a turn, interrupt one, steer one, approve one tool call
4. Switch models mid-thread, confirm `session/configure` lands
5. Trigger `spawn_subagent`, confirm subagent card settles
6. Open two threads at once, confirm both stream over one connection

Record transcript for replay fixture.

---

## Key Design Decisions

1. **One connection per provider session** — mirrors ZeroCode's `Arc<Client>` pattern. T3's `supportsMultipleProviderThreadsPerSession: true` means `openSession` runs once; every thread shares the connection.

2. **`default` is a sentinel** — never sent to daemon. If an override was already applied, fail the turn with an actionable message rather than silently keeping the previous model.

3. **Agent is session-scoped, not turn-scoped** — `SessionOverrides` has no agent field. A changed agent option fails the turn with a visible message.

4. **Text coalescing at 50ms** — matches ACP adapter approach, prevents quadratic snapshot traffic.

5. **Background delegate is a plain tool call** — no subagent card, matching ZeroCode's rule.

6. **No fork/rollback** — capabilities say unsupported; methods fail with `ProviderAdapterProtocolError`.

7. **Approval mode is `approval-required`** — ZeroClaw's own autonomy config decides which tools prompt; T3 documents this rather than hiding it.

8. **No history injection** — `injectHistory` absent; history reaches new threads as synthetic user context via handoff.

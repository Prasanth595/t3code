import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { forkSourceTurns, resolveForkSourcePoint } from "./forkNativeSource.ts";

const now = DateTime.makeUnsafe("2026-10-19T09:21:00Z");
const threadId = ThreadId.make("source");
const runId = RunId.make("run:31");
const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const source: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:pending:run:1"),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "real-session", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 50,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn:31"),
  providerThreadId: source.id,
  nodeId: NodeId.make("node:31"),
  runAttemptId: null,
  nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
  ordinal: 31,
  status: "completed",
  startedAt: now,
  completedAt: now,
};
const compact: OrchestrationV2TurnItem = {
  id: TurnItemId.make("compact:31"),
  type: "compaction",
  driver,
  threadId,
  runId,
  nodeId: turn.nodeId,
  providerThreadId: source.id,
  providerTurnId: turn.id,
  nativeItemRef: { driver, nativeId: "compact-boundary-uuid", strength: "strong" },
  parentItemId: null,
  ordinal: 31,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const registry = ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
  get: () =>
    Effect.succeed({
      driver,
      instanceId,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("fork planning must not open a provider session"),
    }),
  list: () => Effect.succeed([instanceId]),
});
const resolve = (
  providerThread = source,
  items: ReadonlyArray<OrchestrationV2TurnItem> = [compact],
) =>
  resolveForkSourcePoint(
    {
      thread: { providerInstanceId: instanceId },
      providerThreads: [providerThread],
      turnItems: items,
    },
    {
      id: runId,
      providerThreadId: source.id,
      providerInstanceId: instanceId,
      status: "completed",
    },
    {
      threadId,
      runId,
      providerThreadRef: providerThread.nativeThreadRef ?? undefined,
      providerTurnRef: turn.nativeTurnRef ?? undefined,
    },
  ).pipe(Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, registry));

it.effect(
  "recovers an old compact run cursor without treating the durable row id as a session id",
  () =>
    Effect.gen(function* () {
      const point = yield* resolve();
      assert.equal(point.providerThreadRef?.nativeId, "real-session");
      assert.equal(point.providerTurnRef?.nativeId, "compact-boundary-uuid");
      const later = { ...turn, id: ProviderTurnId.make("turn:32"), ordinal: 32 };
      const turns = forkSourceTurns([turn, later], turn, point);
      assert.equal(turns[0]?.nativeTurnRef?.nativeId, "compact-boundary-uuid");
      assert.strictEqual(turns[1], later);
      assert.equal(turn.nativeTurnRef?.nativeId, "turn:synthetic");
    }),
);

it.effect.each([null, { driver, nativeId: "pending:run:1", strength: "strong" } as const])(
  "rejects an unresolved native session before creating a fork: %s",
  (nativeThreadRef) =>
    Effect.gen(function* () {
      const error = yield* resolve({ ...source, nativeThreadRef }).pipe(Effect.flip);
      assert.include(error.message, "native provider session has not been resolved");
    }),
);

it.effect("does not borrow a compaction cursor from a different run", () =>
  Effect.gen(function* () {
    const error = yield* resolve(source, [{ ...compact, runId: RunId.make("run:32") }]).pipe(
      Effect.flip,
    );
    assert.include(error.message, "no native message cursor");
  }),
);

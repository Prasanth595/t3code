import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Threads here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-create-parent" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const create = (threadId: ThreadId, parentThreadId?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-create-parent"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      createdBy: "user",
      creationSource: "server",
    });
    return (yield* orchestrator.getThreadShell(threadId))?.lineage;
  });

it.effect("a thread created under a parent is its subagent and shares its root", () =>
  Effect.gen(function* () {
    const parent = ThreadId.make("thread:parent");
    const child = ThreadId.make("thread:child");
    const grandchild = ThreadId.make("thread:grandchild");

    assert.deepStrictEqual(yield* create(parent), {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parent,
    });
    assert.deepStrictEqual(yield* create(child, parent), {
      parentThreadId: parent,
      relationshipToParent: "subagent",
      rootThreadId: parent,
    });
    assert.deepStrictEqual(yield* create(grandchild, child), {
      parentThreadId: child,
      relationshipToParent: "subagent",
      rootThreadId: parent,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a thread opened for a voice call keeps the account that speaks for it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:voice-marked");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-create-parent"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      voiceCall: { instanceId },
      createdBy: "user",
      creationSource: "server",
    });
    assert.deepStrictEqual((yield* orchestrator.getThreadShell(threadId))?.voiceCall, {
      instanceId,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records spoken lines in a thread's timeline without starting a run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:voice-chat");
    yield* create(threadId);
    const record = (role: "user" | "assistant", text: string, streaming = false, n = 0) =>
      orchestrator.dispatch({
        type: "voice_transcript.record",
        commandId: CommandId.make(`transcript:${role}:${n}`),
        threadId,
        messageId: MessageId.make(`message:${role}`),
        role,
        text,
        streaming,
      });
    yield* record("user", "what is in", true, 0);
    yield* record("user", "what is in the repo", false, 1);
    yield* record("assistant", "a server and a web app");

    const timeline = yield* orchestrator.getTimelinePage(threadId, { limit: 10 });
    assert.deepStrictEqual(
      timeline.items.map(({ item }) => item.type),
      ["user_message", "assistant_message"],
    );
    const { messages, runs } = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
    assert.deepStrictEqual(
      messages.map((message) => [message.role, message.text]),
      [
        ["user", "what is in the repo"],
        ["assistant", "a server and a web app"],
      ],
    );
    assert.deepStrictEqual(runs, []);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:voice-chat"),
      threadId,
    });
    const late = yield* Effect.exit(record("assistant", "too late", false, 3));
    assert.isTrue(Exit.isFailure(late));
  }).pipe(Effect.provide(layerTest)),
);

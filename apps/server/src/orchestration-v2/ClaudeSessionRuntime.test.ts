import fixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };
import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import { assert, it } from "@effect/vitest";
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionResult,
  MessageId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Fence from "./ClaudeSessionFence.ts";

import * as Runtime from "./ClaudeSessionRuntime.ts";
import * as Adapter from "./Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect("guards actual runner offers and approval callbacks at their final effect", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const request = yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(
      requestFixture.input,
    );
    const result = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(fixture);
    if (result.view === null) return yield* Effect.die("missing fixture");
    const row: Journal.ClaudeEnrollment = {
      ...request,
      ownershipGeneration: request.operationId,
      plan: result.view.plan,
      controller: { type: "t3", epoch: 1 },
      sourceTerminal: request.sourceStopped.terminal,
      revision: 1,
      managedWriteRevision: 0,
      view: result.view,
      reservation: null,
      blockers: [],
    };
    yield* sql`INSERT INTO orchestration_v2_claude_sessions VALUES (${row.threadId}, ${row.environmentId}, 'store', ${request.nativeId}, 'transcript', 1, ${JSON.stringify(row)})`;
    let offered = 0;
    let options: Adapter.ClaudeAgentSdkQueryOpenInput["options"] | undefined;
    const session: Adapter.ClaudeAgentSdkQuerySession = {
      managedProcess: { ...request.sourceStopped.terminal.shell, exited: Effect.void },
      messages: Stream.empty,
      offer: () =>
        Effect.sync(() => {
          offered++;
        }),
      setModel: () => Effect.void,
      applyFlagSettings: () => Effect.void,
      setPermissionMode: () => Effect.void,
      stopTask: () => Effect.void,
      backgroundTasks: () => Effect.succeed(false),
      interrupt: Effect.void,
      close: Effect.void,
    };
    const runner = Layer.mock(Adapter.ClaudeAgentSdkQueryRunner, {
      open: (input) =>
        Effect.sync(() => {
          options = input.options;
          return session;
        }),
    });
    const host = Layer.mock(Runtime.ClaudeSessionRuntimeValidation, {
      validatePlan: () => Effect.void,
    });
    yield* Effect.gen(function* () {
      const runtime = yield* Runtime.ClaudeSessionRuntime;
      const guarded = yield* runtime.runner.open({
        threadId: row.threadId,
        providerSessionId: ProviderSessionId.make("fixture-session"),
        controllerEpoch: 1,
        options: {
          model: request.selection.model,
          tools: [],
          permissionMode: "default",
          resume: request.nativeId,
          canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
          onUserDialog: async () => ({ behavior: "completed", result: "continue" }),
          supportedDialogKinds: ["resume_return"],
          extraArgs: { "fixture-flag": "preserved" },
        },
      });
      assert.equal(options?.pathToClaudeCodeExecutable, row.plan.executable.file.path);
      assert.equal(options?.cwd, row.plan.cwd.path);
      assert.equal(options?.env?.HOME, row.plan.home.path);
      assert.deepEqual(options?.extraArgs, {
        "fixture-flag": "preserved",
        "replay-user-messages": null,
      });
      assert.equal(options?.onUserDialog, undefined);
      assert.deepEqual(options?.supportedDialogKinds, []);
      const uuid = "10000000-0000-4000-8000-000000000021";
      yield* guarded.offer(
        {
          type: "user",
          session_id: request.nativeId,
          parent_tool_use_id: null,
          uuid,
          message: { role: "user", content: "input" },
        },
        MessageId.make("app-input"),
      );
      assert.equal(offered, 1);
      assert.equal(
        (yield* guarded
          .offer(
            {
              type: "user",
              session_id: request.nativeId,
              parent_tool_use_id: null,
              uuid: "10000000-0000-4000-8000-000000000023",
              message: { role: "user", content: "input" },
            },
            MessageId.make("app-input"),
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(offered, 1);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_claude_writes WHERE state = 'uncertain'`).length,
        1,
      );
      const elicitation = options?.onElicitation;
      if (elicitation === undefined) return yield* Effect.die("missing guarded elicitation");
      assert.deepEqual(
        yield* Effect.tryPromise(() =>
          elicitation(
            {
              serverName: "fixture-mcp",
              message: "Choose a value",
              mode: "form",
            },
            { signal: new AbortController().signal, requestId: "fixture-elicitation" },
          ),
        ),
        { action: "decline" },
      );
      const elicitationWrites =
        yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${row.threadId} AND json_extract(payload_json, '$.kind') = 'autonomous' AND state = 'returned'`;
      assert.equal(elicitationWrites.length, 1);
      yield* sql`UPDATE orchestration_v2_claude_sessions SET revision = revision + 1, payload_json = json_set(payload_json, '$.controller.type', 'releasing', '$.controller.epoch', 2)`;
      assert.equal(
        (yield* guarded
          .offer(
            {
              type: "user",
              session_id: request.nativeId,
              parent_tool_use_id: null,
              uuid: "10000000-0000-4000-8000-000000000022",
              message: { role: "user", content: "late" },
            },
            MessageId.make("late"),
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(offered, 1);
      const callback = options?.canUseTool;
      if (callback === undefined) return yield* Effect.die("missing callback");
      assert.equal(
        (yield* Effect.tryPromise(() =>
          callback(
            "Bash",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "approval",
              requestId: "approval-request",
            },
          ),
        ).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(
        Runtime.layer.pipe(
          Layer.provide(runner),
          Layer.provide(host),
          Layer.provide(
            Layer.succeed(Runtime.ClaudeSessionProcessProbe, {
              inspect: () => Effect.succeed("alive" as const),
            }),
          ),
          Layer.provide(IdAllocator.layer),
          Layer.provide(Fence.layer.pipe(Layer.provide(Journal.layer))),
        ),
      ),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "settles an accepted approval by its exact tool result and waits for child and manager finalization",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const request = yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(
        requestFixture.input,
      );
      const result = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(fixture);
      if (result.view === null) return yield* Effect.die("missing fixture");
      const row: Journal.ClaudeEnrollment = {
        ...request,
        ownershipGeneration: request.operationId,
        plan: result.view.plan,
        controller: { type: "t3", epoch: 1 },
        sourceTerminal: request.sourceStopped.terminal,
        revision: 1,
        managedWriteRevision: 0,
        view: result.view,
        reservation: null,
        blockers: [],
      };
      yield* sql`INSERT INTO orchestration_v2_claude_sessions VALUES (${row.threadId}, ${row.environmentId}, 'store', ${request.nativeId}, 'transcript', 1, ${JSON.stringify(row)})`;
      const messages = yield* Queue.unbounded<SDKMessage>();
      const processed = yield* Queue.unbounded<void>();
      const childExit = yield* Deferred.make<void>();
      const closeRequested = yield* Deferred.make<void>();
      let options: Adapter.ClaudeAgentSdkQueryOpenInput["options"] | undefined;
      const session: Adapter.ClaudeAgentSdkQuerySession = {
        managedProcess: {
          ...request.sourceStopped.terminal.shell,
          exited: Deferred.await(childExit),
        },
        messages: Stream.fromQueue(messages).pipe(Stream.catchCause(() => Stream.empty)),
        offer: (message) =>
          Effect.gen(function* () {
            const claims =
              yield* sql`SELECT * FROM orchestration_v2_claude_writes WHERE write_id = ${message.uuid ?? "missing"} AND state = 'uncertain'`;
            assert.equal(claims.length, 1);
          }).pipe(Effect.orDie),
        setModel: () => Effect.void,
        applyFlagSettings: () => Effect.void,
        setPermissionMode: () => Effect.void,
        stopTask: () => Effect.void,
        backgroundTasks: () => Effect.succeed(false),
        interrupt: Effect.void,
        close: Deferred.succeed(closeRequested, undefined).pipe(
          Effect.andThen(Queue.shutdown(messages)),
          Effect.asVoid,
        ),
      };
      const runner = Layer.mock(Adapter.ClaudeAgentSdkQueryRunner, {
        open: (input) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* sql`SELECT * FROM orchestration_v2_claude_generations WHERE state = 'spawn-intent'`)
                .length,
              1,
            );
            options = input.options;
            assert.equal(input.managedHandoff, true);
            return session;
          }).pipe(Effect.orDie),
      });
      const dependencies = Layer.mergeAll(
        runner,
        Layer.succeed(Runtime.ClaudeSessionRuntimeValidation, { validatePlan: () => Effect.void }),
        Layer.succeed(Runtime.ClaudeSessionProcessProbe, {
          inspect: () => Effect.succeed("alive" as const),
        }),
        IdAllocator.layer,
        Fence.layer.pipe(Layer.provide(Journal.layer)),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime.ClaudeSessionRuntime;
        const query = yield* runtime.runner.open({
          threadId: row.threadId,
          providerSessionId: ProviderSessionId.make("fixture-session"),
          controllerEpoch: 1,
          options: {
            model: request.selection.model,
            tools: [],
            permissionMode: "default",
            resume: request.nativeId,
            canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
          },
        });
        const reader = yield* query.messages.pipe(
          Stream.runForEach(() => Queue.offer(processed, undefined)),
          Effect.forkScoped,
        );
        const prompt: SDKUserMessage = {
          type: "user",
          session_id: request.nativeId,
          parent_tool_use_id: null,
          uuid: "10000000-0000-4000-8000-000000000031",
          message: { role: "user", content: "read file" },
        };
        yield* query.offer(prompt, MessageId.make("app-prompt"));
        yield* Queue.offer(messages, prompt);
        yield* Queue.take(processed);
        assert.equal((yield* runtime.view(row.threadId)).kind, "owned-query");
        const callback = options?.canUseTool;
        const stop = options?.hooks?.Stop?.[0]?.hooks[0];
        if (callback === undefined || stop === undefined)
          return yield* Effect.die("missing runtime callbacks");
        const response = yield* Effect.tryPromise(() =>
          callback(
            "Read",
            {},
            {
              signal: new AbortController().signal,
              toolUseID: "read-tool",
              requestId: "read-approval",
            },
          ),
        );
        assert.equal(response?.behavior, "allow");
        assert.equal(
          (yield* runtime.assertQuiet(row.threadId).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Queue.offer(messages, {
          ...prompt,
          uuid: "10000000-0000-4000-8000-000000000032",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read-tool", content: "file content" }],
          },
        });
        yield* Queue.take(processed);
        yield* query.setModel(request.selection.model);
        const stopEvent = {
          hook_event_name: "Stop" as const,
          session_id: request.nativeId,
          cwd: "/fixture",
          transcript_path: "/fixture/transcript",
          stop_hook_active: false,
        };
        yield* Effect.tryPromise(() =>
          stop(stopEvent, undefined, { signal: new AbortController().signal }),
        );
        assert.equal(
          (yield* runtime.assertQuiet(row.threadId).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Effect.tryPromise(() =>
          stop({ ...stopEvent, background_tasks: [], session_crons: [] }, undefined, {
            signal: new AbortController().signal,
          }),
        );
        yield* runtime.assertQuiet(row.threadId);
        // SDK EOF finalizes the reader but does not prove the child exited.
        yield* Queue.shutdown(messages);
        yield* Fiber.join(reader);
        assert.equal((yield* runtime.view(row.threadId)).kind, "exit-pending");
        yield* sql`UPDATE orchestration_v2_claude_sessions SET payload_json = json_set(payload_json, '$.controller.type', 'releasing', '$.controller.epoch', 2)`;
        const closing = yield* runtime.close(row.threadId).pipe(Effect.forkScoped);
        yield* Deferred.await(closeRequested);
        assert.equal((yield* runtime.view(row.threadId)).kind, "exit-pending");
        yield* Deferred.succeed(childExit, undefined);
        yield* Fiber.join(closing);
        yield* Fiber.join(reader);
        assert.equal((yield* runtime.view(row.threadId)).kind, "exit-pending");
        const generation = (yield* runtime.generations(row.threadId))[0];
        if (generation === undefined) return yield* Effect.die("missing durable generation");
        yield* runtime.finalized(generation.generation);
        assert.equal((yield* runtime.view(row.threadId)).kind, "exited");
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_claude_writes WHERE state <> 'settled'`)
            .length,
          0,
        );
      }).pipe(Effect.provide(Runtime.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "retains unknown spawn intent across reconstruction and settles only a known absent process",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const request = yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(
        requestFixture.input,
      );
      const result = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(fixture);
      if (result.view === null) return yield* Effect.die("missing fixture");
      const row: Journal.ClaudeEnrollment = {
        ...request,
        ownershipGeneration: request.operationId,
        plan: result.view.plan,
        controller: { type: "releasing", epoch: 2 },
        sourceTerminal: request.sourceStopped.terminal,
        revision: 1,
        managedWriteRevision: 0,
        view: result.view,
        reservation: null,
        blockers: [],
      };
      yield* sql`INSERT INTO orchestration_v2_claude_sessions VALUES (${row.threadId}, ${row.environmentId}, 'store', ${request.nativeId}, 'transcript', 1, ${JSON.stringify(row)})`;
      const generation: Fence.ClaudeGeneration = {
        generation: "10000000-0000-4000-8000-000000000090",
        threadId: row.threadId,
        epoch: 1,
        providerSessionId: "previous-server-session",
        nativeId: request.nativeId,
        process: null,
        state: "spawn-intent",
        nativeObserved: false,
        sdkFinalized: false,
        managerFinalized: false,
        exitReceiptId: null,
        background: "unknown",
      };
      yield* sql`INSERT INTO orchestration_v2_claude_generations VALUES (${generation.generation}, ${row.threadId}, 1, 'spawn-intent', ${JSON.stringify(generation)})`;
      let inspections = 0;
      let processState: "alive" | "absent" | "unknown" = "alive";
      const dependencies = Layer.mergeAll(
        Layer.mock(Adapter.ClaudeAgentSdkQueryRunner, {
          open: () => Effect.die("recovery must never spawn"),
        }),
        Layer.succeed(Runtime.ClaudeSessionRuntimeValidation, { validatePlan: () => Effect.void }),
        Layer.succeed(Runtime.ClaudeSessionProcessProbe, {
          inspect: () =>
            Effect.sync(() => {
              inspections++;
              return processState;
            }),
        }),
        IdAllocator.layer,
        Fence.layer.pipe(Layer.provide(Journal.layer)),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime.ClaudeSessionRuntime;
        const fence = yield* Fence.ClaudeSessionFence;
        assert.equal((yield* runtime.view(row.threadId)).kind, "unknown");
        assert.equal((yield* runtime.close(row.threadId).pipe(Effect.result))._tag, "Failure");
        assert.equal(inspections, 0);
        yield* fence.updateGeneration(generation.generation, {
          process: request.sourceStopped.terminal.shell,
          state: "owned",
        });
        assert.equal((yield* runtime.close(row.threadId).pipe(Effect.result))._tag, "Failure");
        processState = "unknown";
        assert.equal((yield* runtime.close(row.threadId).pipe(Effect.result))._tag, "Failure");
        processState = "absent";
        yield* runtime.close(row.threadId);
        const exited = yield* runtime.view(row.threadId);
        assert.equal(exited.kind, "exited");
        yield* runtime.close(row.threadId);
        assert.deepEqual(yield* runtime.view(row.threadId), exited);
        assert.equal((yield* runtime.view(row.threadId, 3)).kind, "not-started");
        assert.equal((yield* runtime.generations(row.threadId)).length, 1);
      }).pipe(Effect.provide(Runtime.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);

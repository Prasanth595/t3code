import resultFixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };
import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSessionAdoptInput,
  type ClaudeSessionBlocker,
  ClaudeSessionResult,
  MessageId,
  ProviderSessionId,
  ProviderDriverKind,
  EventId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Adapter from "./Adapters/ClaudeAdapterV2.ts";
import * as Manager from "./ProviderSessionManager.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Ownership from "./ClaudeSessionOwnership.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../persistence/Sqlite.ts";
import { captureClaudeSessionSnapshot } from "../claudeSessionSnapshot.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Fence from "./ClaudeSessionFence.ts";
import * as Runtime from "./ClaudeSessionRuntime.ts";
import * as Lifecycle from "./ClaudeSessionLifecycle.ts";

const request = Schema.decodeUnknownSync(ClaudeSessionAdoptInput)(requestFixture.input);
const result = Schema.decodeUnknownSync(ClaudeSessionResult)(resultFixture);
const fixturePlan = (() => {
  if (result.view === null) throw new Error("Missing fixture plan.");
  return result.view.plan;
})();
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, Journal.layer);
const noProcess = Layer.succeed(Runtime.ClaudeSessionLifecycleRuntime, {
  view: () =>
    Effect.succeed({ kind: "not-started" as const, nativeIdentity: "not-observed" as const }),
  assertQuiet: () => Effect.void,
  release: () => Effect.succeed({ kind: "never-started" as const }),
});
const lifecycle = Lifecycle.layer.pipe(
  Layer.provide(noProcess),
  Layer.provide(Fence.layer.pipe(Layer.provide(Journal.layer))),
);
const infrastructure = (databasePath: string) =>
  Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    IdAllocator.layer,
    Ownership.layer(databasePath),
  ).pipe(Layer.provideMerge(Sqlite.layerFromPath(databasePath)));

it.effect.each([false, true])(
  "adopts, refreshes and releases immutable history with exercised runtime=%s",
  (withQuery) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "claude-lifecycle-owned-" });
      const projectDir = path.join(root, "projects", "fixture");
      const cwd = path.join(root, "repo");
      yield* fs.makeDirectory(projectDir, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const transcript = path.join(projectDir, `${request.nativeId}.jsonl`);
      const bytes =
        JSON.stringify({
          type: "user",
          uuid: "10000000-0000-4000-8000-000000000010",
          parentUuid: null,
          sessionId: request.nativeId,
          cwd,
          timestamp: "2026-10-26T00:00:00.000Z",
          message: { role: "user", content: "original saved prompt" },
        }) + "\n";
      yield* fs.writeFileString(transcript, bytes);
      const read = () =>
        Effect.tryPromise(() =>
          captureClaudeSessionSnapshot({
            nativeId: request.nativeId,
            cwd,
            projectsRoot: path.join(root, "projects"),
          }),
        ).pipe(
          Effect.mapError(
            (cause) => new Journal.ClaudeJournalError({ code: "history-unavailable", cause }),
          ),
        );
      const initial = yield* read();
      const rootStat = yield* fs.stat(root);
      const databasePath = path.join(root, "first.sqlite");
      const plan = {
        ...fixturePlan,
        configDir: {
          kind: "unset" as const,
          effectiveRoot: {
            path: root,
            device: String(rootStat.dev),
            inode: String(Option.getOrThrow(rootStat.ino)),
          },
        },
        transcript: initial.transcript,
        projectsRoot: initial.projectsRoot,
        cwd: { ...fixturePlan.cwd, path: cwd },
      };
      const host = Layer.succeed(Lifecycle.ClaudeSessionHost, {
        resolve: () => Effect.succeed(plan),
        read: () => read(),
        validatePlan: () => Effect.void,
        validateStopped: () => Effect.void,
      });
      const messages = yield* Queue.unbounded<SDKMessage>();
      const processed = yield* Queue.unbounded<void>();
      let queryOptions: Adapter.ClaudeAgentSdkQueryOptions | undefined;
      let reader: Fiber.Fiber<void, Adapter.ClaudeAgentSdkQueryRunnerError> | undefined;
      const now = yield* DateTime.now;
      const providerSessionId = ProviderSessionId.make("fixture-claude-session");
      const driver = ProviderDriverKind.make("claudeAgent");
      const sdkSession: Adapter.ClaudeAgentSdkQuerySession = {
        messages: Stream.fromQueue(messages).pipe(Stream.catchCause(() => Stream.empty)),
        managedProcess: { ...request.sourceStopped.terminal.shell, exited: Effect.void },
        offer: () => Effect.void,
        setModel: () => Effect.void,
        applyFlagSettings: () => Effect.void,
        setPermissionMode: () => Effect.void,
        stopTask: () => Effect.void,
        backgroundTasks: () => Effect.succeed(false),
        interrupt: Effect.void,
        close: Queue.shutdown(messages),
      };
      const managerRuntime: ProviderAdapterV2SessionRuntime = {
        instanceId: request.providerInstanceId,
        driver,
        providerSessionId,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId: request.providerInstanceId,
          status: "ready",
          cwd,
          model: request.selection.model,
          capabilities: Adapter.ClaudeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        hasPendingBackgroundWork: Effect.succeed(false),
        ensureThread: () => Effect.die("unused"),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: () => Effect.void,
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
      const raw = Layer.mock(Adapter.ClaudeAgentSdkQueryRunner, {
        open: (input) =>
          Effect.sync(() => {
            queryOptions = input.options;
            return sdkSession;
          }),
      });
      const fenceLayer = Fence.layer.pipe(Layer.provide(Journal.layer));
      const runtimeLayer = Runtime.layer.pipe(
        Layer.provide(raw),
        Layer.provide(fenceLayer),
        Layer.provide(IdAllocator.layer),
        Layer.provide(
          Layer.succeed(Runtime.ClaudeSessionRuntimeValidation, {
            validatePlan: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(Runtime.ClaudeSessionProcessProbe, {
            inspect: () => Effect.succeed("alive" as const),
          }),
        ),
      );
      const runtimePort = Runtime.layerLifecycleRuntime.pipe(
        Layer.provideMerge(runtimeLayer),
        Layer.provide(
          Layer.mock(Manager.ProviderSessionManagerV2, {
            get: () => Effect.succeed(Option.some(managerRuntime)),
            release: () =>
              Effect.suspend(() =>
                reader === undefined ? Effect.void : Fiber.join(reader).pipe(Effect.orDie),
              ),
          }),
        ),
      );
      const testedLifecycle = Lifecycle.layer.pipe(
        Layer.provideMerge(runtimePort),
        Layer.provide(fenceLayer),
      );
      yield* Effect.gen(function* () {
        const sessions = yield* Lifecycle.ClaudeSessionLifecycle;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const adopted = yield* sessions.adopt(request);
        assert.equal(adopted.state, "ready");
        const competing = yield* Effect.gen(function* () {
          const second = yield* Lifecycle.ClaudeSessionLifecycle;
          return yield* second.adopt(request);
        }).pipe(
          Effect.provide(
            Layer.fresh(
              lifecycle.pipe(
                Layer.provide(host),
                Layer.provide(infrastructure(path.join(root, "second.sqlite"))),
              ),
            ),
          ),
        );
        assert.equal(competing.state, "blocked");
        assert.equal(competing.blockers[0]?.code, "native-binding-owned");
        assert.deepEqual(adopted.view?.runtime, {
          kind: "not-started",
          nativeIdentity: "not-observed",
        });
        assert.equal(adopted.view?.controller.epoch, 1);
        assert.equal(
          (yield* projections.getThreadProjection(request.threadId)).messages[0]?.text,
          "original saved prompt",
        );
        assert.equal(yield* fs.readFileString(transcript), bytes);
        const scope = {
          contractVersion: request.contractVersion,
          environmentId: request.environmentId,
          projectId: request.projectId,
          threadId: request.threadId,
        };
        const refreshed = yield* sessions.refresh({
          ...scope,
          operationId: "10000000-0000-4000-8000-000000000004",
          expectedEpoch: 1,
        });
        assert.equal(refreshed.state, "ready");
        assert.equal((yield* projections.getThreadProjection(request.threadId)).messages.length, 1);
        const appMessageId = MessageId.make("mapped-app-prompt");
        if (withQuery) {
          const runtime = yield* Runtime.ClaudeSessionRuntime;
          const sink = yield* EventSink.EventSinkV2;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const projection = yield* projections.getThreadProjection(request.threadId);
          const originalMessage = projection.messages[0];
          const originalItem = projection.turnItems[0];
          if (originalMessage === undefined || originalItem?.type !== "user_message")
            return yield* Effect.die("missing imported user row");
          yield* sink.write({
            events: [
              {
                id: EventId.make("fixture-app-message"),
                type: "message.updated",
                threadId: request.threadId,
                occurredAt: now,
                payload: {
                  ...originalMessage,
                  id: appMessageId,
                  text: "new app input",
                  creationSource: "web",
                },
              },
              {
                id: EventId.make("fixture-app-item"),
                type: "turn-item.updated",
                threadId: request.threadId,
                occurredAt: now,
                payload: {
                  ...originalItem,
                  id: allocator.derive.userTurnItem({ messageId: appMessageId }),
                  messageId: appMessageId,
                  text: "new app input",
                  nativeItemRef: null,
                  ordinal: 2,
                  creationSource: "web",
                },
              },
            ],
          });
          const query = yield* runtime.runner.open({
            threadId: request.threadId,
            providerSessionId,
            controllerEpoch: 1,
            options: {
              resume: request.nativeId,
              model: request.selection.model,
              tools: [],
              permissionMode: "default",
            },
          });
          reader = yield* query.messages.pipe(
            Stream.runForEach(() => Queue.offer(processed, undefined).pipe(Effect.asVoid)),
            Effect.forkScoped,
          );
          const prompt: SDKUserMessage = {
            type: "user",
            session_id: request.nativeId,
            parent_tool_use_id: null,
            uuid: "10000000-0000-4000-8000-000000000041",
            message: { role: "user", content: "new app input" },
          };
          yield* query.offer(prompt, appMessageId);
          yield* Queue.offer(messages, prompt);
          yield* Queue.take(processed);
          const stop = queryOptions?.hooks?.Stop?.[0]?.hooks[0];
          if (stop === undefined) return yield* Effect.die("missing stop inventory hook");
          yield* Effect.tryPromise(() =>
            stop(
              {
                hook_event_name: "Stop",
                session_id: request.nativeId,
                cwd,
                transcript_path: transcript,
                stop_hook_active: false,
                background_tasks: [],
                session_crons: [],
              },
              undefined,
              { signal: new AbortController().signal },
            ),
          );
          yield* fs.writeFileString(
            transcript,
            bytes +
              JSON.stringify({
                type: "user",
                uuid: prompt.uuid,
                parentUuid: "10000000-0000-4000-8000-000000000010",
                sessionId: request.nativeId,
                cwd,
                timestamp: "2026-10-26T00:01:00.000Z",
                message: prompt.message,
              }) +
              "\n",
          );
          assert.equal((yield* sessions.status(scope)).view?.runtime.kind, "owned-query");
        }
        const releaseInput = {
          ...scope,
          operationId: "10000000-0000-4000-8000-000000000005",
          expectedEpoch: 1,
          planDigest: plan.planDigest,
          destination: request.sourceStopped.terminal,
        };
        const released = yield* sessions.release(releaseInput);
        assert.equal(released.state, "ready");
        assert.equal(
          released.reservation?.processDisposition.kind,
          withQuery ? "exited" : "never-started",
        );
        if (withQuery) {
          const projection = yield* projections.getThreadProjection(request.threadId);
          assert.equal(projection.messages.length, 2);
          assert.equal(
            projection.messages.filter((message) => message.text === "new app input").length,
            1,
          );
          assert.equal(
            projection.messages.find((message) => message.text === "new app input")?.id,
            appMessageId,
          );
          assert.equal(
            projection.messages.find((message) => message.id === appMessageId)?.creationSource,
            "web",
          );
          assert.equal(
            projection.providerThreads[0]?.nativeMetadata?.historyGeneration,
            released.view?.history.generation,
          );
        }
        assert.equal(released.view?.controller.epoch, 2);
        assert.deepEqual(yield* sessions.release(releaseInput), released);
        assert.deepEqual(yield* sessions.adopt(request), adopted);
        const current = yield* sessions.status(scope);
        assert.equal(current.operationId, null);
        assert.equal(current.view?.controller.type, "external");
        assert.deepEqual(
          yield* sessions.status({ ...scope, operationId: request.operationId }),
          adopted,
        );
        const denied = yield* sessions.adopt({
          ...request,
          operationId: "10000000-0000-4000-8000-000000000008",
          expectedEpoch: 2,
        });
        assert.equal(denied.state, "blocked");
        assert.equal(denied.blockers[0]?.code, "previous-return-unresolved");
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_claude_generations`).length,
          withQuery ? 1 : 0,
        );
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_claude_writes WHERE state <> 'settled'`)
            .length,
          0,
        );
      }).pipe(
        Effect.provide(
          testedLifecycle.pipe(
            Layer.provide(host),
            Layer.provideMerge(infrastructure(databasePath)),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns actionable blockers for unsupported profiles and unresolved work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "claude-blocker-owned-" });
    let code: ClaudeSessionBlocker["code"] = "unsupported-platform";
    const cases: ReadonlyArray<
      readonly [ClaudeSessionBlocker["code"], ClaudeSessionBlocker["nextAction"]]
    > = [
      ["unsupported-platform", "unsupported"],
      ["unsupported-profile", "unsupported"],
      ["contract-unsupported", "unsupported"],
      ["managed-work-active", "resolve-in-t3"],
      ["settings-changed", "reselect"],
      ["identity-changed", "reselect"],
      ["managed-delivery-unknown", "resolve-in-t3"],
    ];
    yield* Effect.gen(function* () {
      const sessions = yield* Lifecycle.ClaudeSessionLifecycle;
      for (const [failure, action] of cases) {
        code = failure;
        const blocked = yield* sessions.adopt(request);
        assert.equal(blocked.state, "blocked");
        assert.equal(blocked.blockers[0]?.code, failure);
        assert.equal(blocked.blockers[0]?.nextAction, action);
        assert.notInclude(blocked.blockers[0]?.detail ?? "", "requires reconciliation");
      }
    }).pipe(
      Effect.provide(
        lifecycle.pipe(
          Layer.provide(
            Layer.mock(Lifecycle.ClaudeSessionHost, {
              resolve: () =>
                Effect.suspend(() => Effect.fail(new Journal.ClaudeJournalError({ code }))),
            }),
          ),
          Layer.provide(infrastructure(path.join(root, "blockers.sqlite"))),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

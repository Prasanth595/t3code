import {
  type ClaudeSessionProcess,
  type ClaudeSessionIdentityPlan,
  type ClaudeSessionView,
  type ClaudeSessionReservation,
  ThreadId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Adapter from "./Adapters/ClaudeAdapterV2.ts";
import * as Fence from "./ClaudeSessionFence.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Manager from "./ProviderSessionManager.ts";

export class ClaudeSessionRuntimeValidation extends Context.Service<
  ClaudeSessionRuntimeValidation,
  {
    readonly validatePlan: (
      plan: ClaudeSessionIdentityPlan,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionRuntime/ClaudeSessionRuntimeValidation") {}

export class ClaudeSessionProcessProbe extends Context.Service<
  ClaudeSessionProcessProbe,
  {
    readonly inspect: (
      process: ClaudeSessionProcess,
    ) => Effect.Effect<"alive" | "absent" | "unknown", Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionRuntime/ClaudeSessionProcessProbe") {}

export const layerProcessProbe = Layer.effect(
  ClaudeSessionProcessProbe,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const boot = fs
      .readFileString("/proc/sys/kernel/random/boot_id")
      .pipe(Effect.map((value) => value.trim()));
    const inspect = Effect.fn("ClaudeSessionProcessProbe.inspect")(
      function* (process: ClaudeSessionProcess) {
        if ((yield* boot) !== process.boot) return "unknown" as const;
        const current = yield* fs.readFileString(`/proc/${process.pid}/stat`).pipe(Effect.result);
        if (current._tag === "Failure")
          return current.failure.reason._tag === "NotFound"
            ? ("absent" as const)
            : ("unknown" as const);
        const start = current.success.slice(current.success.lastIndexOf(")") + 2).split(" ")[19];
        if (start === undefined || !/^\d+$/.test(start)) return "unknown" as const;
        return start === process.start ? ("alive" as const) : ("absent" as const);
      },
      (effect) =>
        effect.pipe(
          Effect.mapError(
            (cause) => new Journal.ClaudeJournalError({ code: "process-exit-unproved", cause }),
          ),
        ),
    );
    return ClaudeSessionProcessProbe.of({ inspect });
  }),
);

type ClaudeSessionRuntimeView = ClaudeSessionView["runtime"];
type Disposition = ClaudeSessionReservation["processDisposition"];
export class ClaudeSessionRuntime extends Context.Service<
  ClaudeSessionRuntime,
  {
    readonly runner: Adapter.ClaudeAgentSdkQueryRunnerShape;
    readonly view: (
      threadId: ThreadId,
      epoch?: number,
    ) => Effect.Effect<ClaudeSessionRuntimeView, Journal.ClaudeJournalError>;
    readonly assertQuiet: (threadId: ThreadId) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly close: (threadId: ThreadId) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly generations: Fence.ClaudeSessionFence["Service"]["generations"];
    readonly finalized: (generation: string) => Effect.Effect<void, Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionRuntime") {}

export class ClaudeSessionLifecycleRuntime extends Context.Service<
  ClaudeSessionLifecycleRuntime,
  {
    readonly view: ClaudeSessionRuntime["Service"]["view"];
    readonly assertQuiet: ClaudeSessionRuntime["Service"]["assertQuiet"];
    readonly release: (
      threadId: ThreadId,
    ) => Effect.Effect<Disposition, Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionRuntime/ClaudeSessionLifecycleRuntime") {}

const runnerError = (cause: unknown) =>
  new Adapter.ClaudeAgentSdkQueryRunnerError({ method: "handoff", cause });
const journalError = (cause: unknown) =>
  Schema.is(Journal.ClaudeJournalError)(cause)
    ? cause
    : new Journal.ClaudeJournalError({ code: "runtime-state-unknown", cause });

export const layer = Layer.effect(
  ClaudeSessionRuntime,
  Effect.gen(function* () {
    const raw = yield* Adapter.ClaudeAgentSdkQueryRunner;
    const fence = yield* Fence.ClaudeSessionFence;
    const validation = yield* ClaudeSessionRuntimeValidation;
    const processes = yield* ClaudeSessionProcessProbe;
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const sessions = new Map<string, Adapter.ClaudeAgentSdkQuerySession>();
    const view = Effect.fn("ClaudeSessionRuntime.view")(function* (
      threadId: ThreadId,
      epoch?: number,
    ): Effect.fn.Return<ClaudeSessionRuntimeView, Journal.ClaudeJournalError> {
      const generations = (yield* fence.generations(threadId)).filter(
        (generation) =>
          epoch === undefined ||
          generation.epoch === epoch ||
          generation.state !== "exited" ||
          !generation.sdkFinalized ||
          !generation.managerFinalized,
      );
      if (generations.length === 0) return { kind: "not-started", nativeIdentity: "not-observed" };
      const unresolved = generations.filter(
        (generation) =>
          generation.state !== "exited" || !generation.sdkFinalized || !generation.managerFinalized,
      );
      if (unresolved.length > 1) return { kind: "unknown" };
      const generation = unresolved[0];
      if (generation === undefined) {
        const receipt = generations.at(-1)?.exitReceiptId;
        return receipt == null ? { kind: "unknown" } : { kind: "exited", exitReceiptId: receipt };
      }
      if (
        generation.state === "closing" ||
        generation.state === "exited" ||
        generation.sdkFinalized
      )
        return { kind: "exit-pending", generation: generation.generation };
      if (generation.process === null || !sessions.has(generation.generation))
        return { kind: "unknown" };
      return {
        kind: "owned-query",
        generation: generation.generation,
        process: generation.process,
        nativeIdentity: generation.nativeObserved ? "observed-exact-uuid" : "not-observed",
      };
    });
    const assertQuiet = Effect.fn("ClaudeSessionRuntime.assertQuiet")(function* (
      threadId: ThreadId,
    ) {
      if ((yield* fence.pending(threadId)).length > 0)
        return yield* new Journal.ClaudeJournalError({ code: "managed-delivery-unknown" });
      for (const generation of yield* fence.generations(threadId)) {
        if (generation.state === "exited" && generation.sdkFinalized && generation.managerFinalized)
          continue;
        if (generation.process === null)
          return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
        if (!sessions.has(generation.generation)) {
          if ((yield* processes.inspect(generation.process)) === "absent") continue;
          return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
        }
        if (
          generation.state !== "closing" &&
          generation.state !== "exited" &&
          generation.background !== "quiet"
        )
          return yield* new Journal.ClaudeJournalError({
            code:
              generation.background === "busy" ? "managed-work-active" : "runtime-state-unknown",
          });
      }
    });
    const open = Effect.fn("ClaudeSessionRuntime.open")(
      function* (input: Adapter.ClaudeAgentSdkQueryOpenInput) {
        const epoch = input.controllerEpoch ?? 0;
        const plan = yield* fence.plan(input.threadId, epoch);
        if (plan === null) return yield* raw.open(input);
        yield* validation.validatePlan(plan);
        if (
          input.options.resume !== plan.nativeId ||
          input.options.sessionId !== undefined ||
          input.options.resumeSessionAt !== undefined ||
          input.options.model !== plan.selection.model ||
          input.options.permissionMode !== plan.sdkPermissionMode
        )
          return yield* new Journal.ClaudeJournalError({ code: "settings-changed" });
        const generation = yield* fence.spawnIntent({
          threadId: input.threadId,
          epoch,
          providerSessionId: input.providerSessionId,
          nativeId: plan.nativeId,
        });
        if (generation === null)
          return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
        const claim = Effect.fn("ClaudeSessionRuntime.claim")(function* (
          kind: Fence.ClaudeWrite["kind"],
          payload: unknown,
          extra?: { prompt?: NonNullable<Fence.ClaudeWrite["prompt"]>; toolUseId?: string },
        ) {
          yield* validation.validatePlan(plan);
          return yield* fence.claim({
            threadId: input.threadId,
            epoch,
            generation: generation.generation,
            kind,
            payload,
            ...extra,
          });
        });
        const control = Effect.fn("ClaudeSessionRuntime.control")(
          function* <A>(
            method: string,
            payload: unknown,
            effect: Effect.Effect<A, Adapter.ClaudeAgentSdkQueryRunnerError>,
          ) {
            const write = yield* claim("control", { method, payload });
            const value = yield* effect;
            // These SDK methods resolve only after their own request_id control response.
            yield* fence.acknowledge(write);
            return value;
          },
          (effect) => effect.pipe(Effect.mapError(runnerError)),
        );
        const original = input.options;
        const canUseTool = original.canUseTool;
        const environment: NonNullable<Adapter.ClaudeAgentSdkQueryOptions["env"]> = {
          ...original.env,
          HOME: plan.home.path,
        };
        if (plan.configDir.kind === "set") environment.CLAUDE_CONFIG_DIR = plan.configDir.value;
        else delete environment.CLAUDE_CONFIG_DIR;
        const options: Adapter.ClaudeAgentSdkQueryOptions = {
          ...original,
          pathToClaudeCodeExecutable: plan.executable.file.path,
          cwd: plan.cwd.path,
          env: environment,
          // Native stdin delivery acknowledgement preserves the caller's prompt UUID.
          extraArgs: { ...original.extraArgs, "replay-user-messages": null },
          // Managed profiles disable idle compaction. An unadvertised resume_return
          // dialog defaults to cancelled in the CLI and does not compact or park.
          supportedDialogKinds: [],
          // The SDK otherwise declines MCP elicitation automatically. There is no
          // exposed correlated native acknowledgement, so this write stays pending.
          onElicitation: async (request, callback) => {
            const response = { action: "decline" as const };
            const write = await runPromise(
              claim("autonomous", {
                method: "elicitation",
                requestId: callback.requestId,
                request,
                response,
              }),
            );
            await runPromise(fence.returned(write));
            return response;
          },
          hooks: {
            ...original.hooks,
            Stop: [
              ...(original.hooks?.Stop ?? []),
              {
                hooks: [
                  async (event) => {
                    if (event.hook_event_name === "Stop" && event.session_id === plan.nativeId) {
                      await runPromise(
                        fence.updateGeneration(generation.generation, {
                          background:
                            event.background_tasks === undefined ||
                            event.session_crons === undefined
                              ? "unknown"
                              : event.background_tasks.length > 0 || event.session_crons.length > 0
                                ? "busy"
                                : "quiet",
                        }),
                      );
                    }
                    return {};
                  },
                ],
              },
            ],
          },
          ...(canUseTool === undefined
            ? {}
            : {
                canUseTool: async (
                  ...args: Parameters<NonNullable<typeof original.canUseTool>>
                ) => {
                  await runPromise(fence.plan(input.threadId, epoch));
                  const response = await canUseTool(...args);
                  const write = await runPromise(
                    claim(
                      "approval",
                      { tool: args[0], toolUseId: args[2].toolUseID, response },
                      { toolUseId: args[2].toolUseID },
                    ),
                  );
                  await runPromise(fence.returned(write));
                  return response;
                },
              }),
        };
        delete options.onUserDialog;
        const session = yield* raw.open({ ...input, options, managedHandoff: true });
        if (session.managedProcess === undefined)
          return yield* new Journal.ClaudeJournalError({ code: "identity-unavailable" });
        const { pid, start, boot } = session.managedProcess;
        const process = { pid, start, boot };
        yield* fence.updateGeneration(generation.generation, { process, state: "owned" });
        const closeManaged = Effect.gen(function* () {
          yield* fence.updateGeneration(generation.generation, { state: "closing" });
          yield* session.close;
          if (session.managedProcess === undefined)
            return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
          yield* session.managedProcess.exited.pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.fail(new Journal.ClaudeJournalError({ code: "process-exit-unproved" })),
            }),
          );
          yield* fence.updateGeneration(generation.generation, {
            state: "exited",
            exitReceiptId: yield* randomUuidV4,
          });
        }).pipe(Effect.mapError(runnerError));
        sessions.set(generation.generation, { ...session, close: closeManaged });
        return {
          ...session,
          messages: session.messages.pipe(
            Stream.tap((message) =>
              Effect.gen(function* () {
                if (
                  message.type === "assistant" ||
                  message.type === "stream_event" ||
                  message.type === "user" ||
                  (message.type === "system" &&
                    ["task_started", "task_progress", "task_notification"].includes(
                      message.subtype,
                    ))
                ) {
                  yield* fence.updateGeneration(generation.generation, { background: "unknown" });
                }
                yield* fence.observe(generation.generation, message);
              }).pipe(Effect.mapError(runnerError)),
            ),
            Stream.ensuring(
              fence
                .updateGeneration(generation.generation, { sdkFinalized: true })
                .pipe(Effect.orDie),
            ),
          ),
          offer: Effect.fn("ClaudeSessionRuntime.offer")(
            function* (message, messageId) {
              if (message.uuid === undefined || messageId === undefined)
                return yield* new Journal.ClaudeJournalError({ code: "managed-delivery-unknown" });
              yield* claim(message.priority === "now" ? "steer" : "prompt", message, {
                prompt: {
                  uuid: message.uuid,
                  messageId,
                  turnItemId: allocator.derive.userTurnItem({ messageId }),
                },
              });
              yield* fence.updateGeneration(generation.generation, { background: "unknown" });
              yield* session.offer(message, messageId);
              // Queue acceptance is not native delivery acknowledgement.
            },
            (effect) => effect.pipe(Effect.mapError(runnerError)),
          ),
          setModel: (model) => control("setModel", model, session.setModel(model)),
          applyFlagSettings: (settings) =>
            control("applyFlagSettings", settings, session.applyFlagSettings(settings)),
          setPermissionMode: (mode) =>
            control("setPermissionMode", mode, session.setPermissionMode(mode)),
          stopTask: (taskId) => control("stopTask", taskId, session.stopTask(taskId)),
          backgroundTasks: (toolUseId) =>
            control("backgroundTasks", toolUseId, session.backgroundTasks(toolUseId)),
          interrupt: control("interrupt", null, session.interrupt),
          close: closeManaged,
        } satisfies Adapter.ClaudeAgentSdkQuerySession;
      },
      (effect) => effect.pipe(Effect.mapError(runnerError)),
    );
    const close = Effect.fn("ClaudeSessionRuntime.close")(function* (threadId: ThreadId) {
      yield* assertQuiet(threadId);
      for (const generation of yield* fence.generations(threadId)) {
        if (generation.state === "exited" && generation.sdkFinalized && generation.managerFinalized)
          continue;
        if (generation.process === null)
          return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
        const session = sessions.get(generation.generation);
        if (session !== undefined) {
          yield* session.close.pipe(Effect.mapError(journalError));
        } else {
          if ((yield* processes.inspect(generation.process)) !== "absent")
            return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
          yield* fence.updateGeneration(generation.generation, {
            state: "exited",
            sdkFinalized: true,
            managerFinalized: true,
            exitReceiptId: generation.exitReceiptId ?? (yield* randomUuidV4),
          });
        }
      }
    });
    return ClaudeSessionRuntime.of({
      runner: { ...raw, open },
      view,
      assertQuiet,
      close,
      generations: fence.generations,
      finalized: (generation) => fence.updateGeneration(generation, { managerFinalized: true }),
    });
  }),
);

export const layerLifecycleRuntime = Layer.effect(
  ClaudeSessionLifecycleRuntime,
  Effect.gen(function* () {
    const runtime = yield* ClaudeSessionRuntime;
    const manager = yield* Manager.ProviderSessionManagerV2;
    const assertQuiet = Effect.fn("ClaudeSessionLifecycleRuntime.assertQuiet")(function* (
      threadId: ThreadId,
    ) {
      yield* runtime.assertQuiet(threadId);
      for (const generation of yield* runtime.generations(threadId)) {
        if (generation.state === "exited" && generation.managerFinalized) continue;
        const managed = yield* manager
          .get(ProviderSessionId.make(generation.providerSessionId))
          .pipe(Effect.mapError(journalError));
        if (Option.isNone(managed)) {
          if ((yield* runtime.view(threadId)).kind === "owned-query")
            return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
          continue;
        }
        if (managed.value.hasPendingBackgroundWork === undefined)
          return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
        if (yield* managed.value.hasPendingBackgroundWork.pipe(Effect.mapError(journalError)))
          return yield* new Journal.ClaudeJournalError({ code: "managed-work-active" });
      }
    });
    return ClaudeSessionLifecycleRuntime.of({
      view: runtime.view,
      assertQuiet,
      release: Effect.fn("ClaudeSessionLifecycleRuntime.release")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<Disposition, Journal.ClaudeJournalError> {
        yield* assertQuiet(threadId);
        yield* runtime.close(threadId);
        for (const generation of yield* runtime.generations(threadId)) {
          if (generation.managerFinalized) continue;
          yield* manager
            .release({
              providerSessionId: ProviderSessionId.make(generation.providerSessionId),
              reason: "manual_shutdown",
              requireSettled: true,
            })
            .pipe(Effect.mapError(journalError));
          yield* runtime.finalized(generation.generation);
        }
        const view = yield* runtime.view(threadId);
        if (view.kind === "not-started") return { kind: "never-started" };
        if (view.kind === "exited") return { kind: "exited", exitReceiptId: view.exitReceiptId };
        return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
      }),
    });
  }),
);

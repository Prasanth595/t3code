// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 binds schema-encoded source command and runtime bytes.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  OrchestrationV2Command,
  NonNegativeInt,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import { RetroId } from "../../../../packages/contracts/src/missionRetro.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  encodeMissionCommand,
  encodeMissionRuntime,
  missionCommandHashes,
} from "./MissionCommandBinding.ts";
import type { MissionRetroAnalysisClaimCommand } from "./MissionRetroAnalysisStore.ts";
import { MissionAuthority } from "./MissionService.ts";
import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class MissionRetroDispatchBindingError extends Schema.TaggedError<MissionRetroDispatchBindingError>()(
  "MissionRetroDispatchBindingError",
  {
    category: Schema.Literals([
      "invalid_command",
      "scope_denied",
      "runtime_denied",
      "binding_changed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Retro source dispatch binding failed (${this.category}).`;
  }
}

type DelegatedCommand = Extract<OrchestrationV2Command, { type: "delegated_task.request" }>;
const Claim = Schema.Struct({
  commandId: CommandId,
  missionId: RetroId,
  checkpointId: RetroId,
  expectedRevision: NonNegativeInt,
  retroEpoch: NonNegativeInt,
});
const EffectiveRoute = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  modelId: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  company: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  capability: Schema.Literals(["read_only", "writer"]),
  verified: Schema.Boolean,
});

const decodeCommand = Schema.decodeEffect(OrchestrationV2Command);
const decodeClaim = Schema.decodeUnknownEffect(Claim);
const decodeRoute = Schema.decodeUnknownEffect(EffectiveRoute);

/** Live server resolution, never a proposal/default-profile inference. No production layer yet. */
export class MissionRetroRuntimePort extends Context.Service<
  MissionRetroRuntimePort,
  {
    readonly resolve: (input: {
      readonly command: DelegatedCommand;
      readonly thread: OrchestrationV2AppThread;
      readonly runtime: ProviderAdapterV2RuntimePolicy;
    }) => Effect.Effect<typeof EffectiveRoute.Type, MissionRetroDispatchBindingError>;
  }
>()("t3/orchestration-v2/MissionRetroDispatchBinding/MissionRetroRuntimePort") {}

const seal: unique symbol = Symbol("PreparedMissionRetroDispatch");
const preparations = new WeakSet<PreparedMissionRetroDispatch>();
export interface PreparedMissionRetroDispatch {
  readonly [seal]: true;
  readonly command: DelegatedCommand;
  readonly claim: MissionRetroAnalysisClaimCommand;
  readonly projectId: string;
  readonly teamId: string;
  readonly environmentId: string;
  readonly controllerThreadId: ThreadId;
  readonly reporterChildThreadId: ThreadId;
  readonly reporterRunId: string;
  readonly sourceCommandDigest: string;
  readonly promptHash: string;
  readonly optionsHash: string;
  readonly runtimeBytes: string;
  readonly routeBytes: string;
  readonly route: typeof EffectiveRoute.Type;
}
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
const freeze = <A>(value: A): A => {
  if (typeof value === "object" && value !== null && !DateTime.isDateTime(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
/** Store and Orchestrator authenticate the same opaque preparation; structurally forged values fail. */
export const authenticateRetroDispatch = (
  value: PreparedMissionRetroDispatch,
): Effect.Effect<PreparedMissionRetroDispatch, MissionRetroDispatchBindingError> =>
  preparations.has(value)
    ? Effect.succeed(value)
    : Effect.fail(new MissionRetroDispatchBindingError({ category: "invalid_command" }));

export class MissionRetroDispatchBinding extends Context.Service<
  MissionRetroDispatchBinding,
  {
    readonly prepare: (
      command: OrchestrationV2ServerCommand,
      claim: MissionRetroAnalysisClaimCommand,
      thread: OrchestrationV2AppThread,
    ) => Effect.Effect<PreparedMissionRetroDispatch, MissionRetroDispatchBindingError>;
    readonly recheck: (
      prepared: PreparedMissionRetroDispatch,
      command: OrchestrationV2ServerCommand,
      thread: OrchestrationV2AppThread,
    ) => Effect.Effect<void, MissionRetroDispatchBindingError>;
  }
>()("t3/orchestration-v2/MissionRetroDispatchBinding") {}

const make = Effect.gen(function* () {
  const runtimePolicy = yield* RuntimePolicyV2;
  const liveRuntime = yield* MissionRetroRuntimePort;
  const authority = freeze(structuredClone(yield* MissionAuthority));
  const ids = yield* IdAllocatorV2;
  const capture = Effect.fn("MissionRetroDispatchBinding.capture")(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
  ) {
    if (command.type !== "delegated_task.request")
      return yield* new MissionRetroDispatchBindingError({ category: "invalid_command" });
    const encoded = yield* encodeMissionCommand(command, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (cause) => new MissionRetroDispatchBindingError({ category: "invalid_command", cause }),
      ),
    );
    const actual = freeze(
      yield* decodeCommand(structuredClone(encoded), {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (cause) => new MissionRetroDispatchBindingError({ category: "invalid_command", cause }),
        ),
      ),
    );
    if (actual.type !== "delegated_task.request")
      return yield* new MissionRetroDispatchBindingError({ category: "invalid_command" });
    if (
      actual.parentThreadId !== authority.controllerThreadId ||
      thread.id !== actual.parentThreadId ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null
    )
      return yield* new MissionRetroDispatchBindingError({ category: "scope_denied" });
    const selection = actual.modelSelection;
    const profiles = selection.options?.filter((option) => option.id === "profile") ?? [];
    if (
      (selection.instanceId !== "muse-personal" &&
        selection.instanceId !== "muse-backstage-support") ||
      selection.model !== "muse-spark-1.3-contributor" ||
      profiles.length !== 1 ||
      profiles[0]!.value !== "muse-review" ||
      actual.runtimeMode !== "full-access" ||
      thread.runtimeMode !== "full-access" ||
      actual.interactionMode !== "default" ||
      thread.interactionMode !== "default"
    )
      return yield* new MissionRetroDispatchBindingError({ category: "runtime_denied" });
    const effectiveThread = {
      ...thread,
      worktreePath: actual.workspaceBinding?.worktreePath ?? thread.worktreePath,
    };
    const runtime = yield* runtimePolicy
      .resolve({ thread: effectiveThread, modelSelection: selection })
      .pipe(
        Effect.mapError(
          (cause) => new MissionRetroDispatchBindingError({ category: "runtime_denied", cause }),
        ),
      );
    if (
      runtime.runtimeMode !== "full-access" ||
      runtime.interactionMode !== "default" ||
      runtime.cwd === null ||
      runtime.cwd.length === 0
    )
      return yield* new MissionRetroDispatchBindingError({ category: "runtime_denied" });
    const route = freeze(
      yield* decodeRoute(
        yield* liveRuntime.resolve({
          command: actual,
          thread: freeze(structuredClone(effectiveThread)),
          runtime: freeze(structuredClone(runtime)),
        }),
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(
          (cause) => new MissionRetroDispatchBindingError({ category: "runtime_denied", cause }),
        ),
      ),
    );
    if (
      !route.verified ||
      route.providerInstanceId !== selection.instanceId ||
      route.modelId !== selection.model ||
      route.company !== "No Fun" ||
      route.profile !== "muse-review" ||
      route.capability !== "read_only"
    )
      return yield* new MissionRetroDispatchBindingError({ category: "runtime_denied" });
    const normalized = yield* encodeMissionCommand(actual, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (cause) => new MissionRetroDispatchBindingError({ category: "invalid_command", cause }),
      ),
    );
    const encodedRuntime = yield* encodeMissionRuntime(runtime, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (cause) => new MissionRetroDispatchBindingError({ category: "runtime_denied", cause }),
      ),
    );
    const hashes = missionCommandHashes(normalized, thread.projectId, encodedRuntime);
    if (hashes === undefined)
      return yield* new MissionRetroDispatchBindingError({ category: "invalid_command" });
    return {
      command: actual,
      projectId: thread.projectId,
      sourceCommandDigest: hash(normalized),
      ...hashes,
      runtimeBytes: stableStringify(encodedRuntime),
      routeBytes: stableStringify(route),
      route,
    };
  });
  const prepare = Effect.fn("MissionRetroDispatchBinding.prepare")(function* (
    command: OrchestrationV2ServerCommand,
    input: MissionRetroAnalysisClaimCommand,
    thread: OrchestrationV2AppThread,
  ) {
    const claim = freeze(
      yield* decodeClaim(structuredClone(input), {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (cause) => new MissionRetroDispatchBindingError({ category: "invalid_command", cause }),
        ),
      ),
    );
    const bound = yield* capture(command, thread);
    if (bound.command.commandId === claim.commandId)
      return yield* new MissionRetroDispatchBindingError({ category: "invalid_command" });
    // Child/run derive from the source command. The pair receipt includes these
    // identities, so using its ID as the planner input would be a circular hash.
    const child = ids.derive.delegatedTaskThread({ commandId: bound.command.commandId });
    const prepared: PreparedMissionRetroDispatch = freeze({
      [seal]: true as const,
      ...bound,
      claim,
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      controllerThreadId: authority.controllerThreadId,
      reporterChildThreadId: child,
      reporterRunId: ids.derive.run({ threadId: child, ordinal: 1 }),
    });
    preparations.add(prepared);
    return prepared;
  });
  const recheck = Effect.fn("MissionRetroDispatchBinding.recheck")(function* (
    prepared: PreparedMissionRetroDispatch,
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
  ) {
    yield* authenticateRetroDispatch(prepared);
    const current = yield* capture(command, thread);
    if (
      prepared.teamId !== authority.teamId ||
      prepared.environmentId !== authority.environmentId ||
      prepared.controllerThreadId !== authority.controllerThreadId ||
      current.sourceCommandDigest !== prepared.sourceCommandDigest ||
      current.projectId !== prepared.projectId ||
      current.optionsHash !== prepared.optionsHash ||
      current.runtimeBytes !== prepared.runtimeBytes ||
      current.routeBytes !== prepared.routeBytes
    )
      return yield* new MissionRetroDispatchBindingError({ category: "binding_changed" });
  });
  return MissionRetroDispatchBinding.of({ prepare, recheck });
});
export const layer = Layer.effect(MissionRetroDispatchBinding, make);

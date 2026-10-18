import { CommandId, MissionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";

import {
  ProPlanningAction,
  ProPlanningEvent,
  ProPlanningId,
  ProPlanningReasonCode,
  ProPlanningRecord,
  ProPlanningReservationAck,
} from "../../../../packages/contracts/src/missionProPlanning.ts";
import * as Combined from "../orchestration-v2/CombinedMissionRuntime.ts";
import type { MissionPlanningResult } from "../orchestration-v2/MissionPlanningStore.ts";
import * as Invocation from "./McpInvocationContext.ts";

// No observations, authority, usage, approval or GUI-verification parameters.
// They come from the configured trusted producer and current canonical request.
const CommitInput = Schema.Struct({
  missionId: MissionId,
  commandId: CommandId,
  event: ProPlanningEvent,
});
const RestartInput = Schema.Struct({
  missionId: MissionId,
  commandId: CommandId,
  planningId: ProPlanningId,
});
const PlanningResult = Schema.Struct({
  status: Schema.Literals(["committed", "replayed", "existing", "hold", "deny"]),
  action: ProPlanningAction,
  reasons: Schema.Array(ProPlanningReasonCode),
  thisCallWrote: Schema.Boolean,
  recordPersisted: Schema.NullOr(Schema.Boolean),
  sideEffectAuthorized: Schema.Boolean,
  submitAuthorized: Schema.Boolean,
  durableGuiLease: Schema.Literals(["held", "released", "absent", "unknown"]),
  record: Schema.NullOr(ProPlanningRecord),
  reservation: Schema.NullOr(ProPlanningReservationAck),
});

class PlanningFailure extends Schema.TaggedError<PlanningFailure>()("MissionPlanningMcpFailure", {
  code: Schema.Literals(["planning_unavailable", "scope_denied", "persistence"]),
}) {}

const dependencies = [Invocation.McpInvocationContext, Combined.CombinedMissionRuntime];
const Commit = Tool.make("mission_planning_commit", {
  description:
    "Persist one bounded Pro-planning transition under the current delivery manager epoch. Needs an internal T3 orchestration thread and an independently configured trusted observation producer. Caller claims never supply quota, approval or GUI evidence. A committed reservation is distinct from a GUI submission; replay never authorizes another submit. No provider or GUI call is made here.",
  parameters: CommitInput,
  success: PlanningResult,
  failure: PlanningFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Commit a planning transition")
  .annotate(Tool.Destructive, true);
const Restart = Tool.make("mission_planning_resume", {
  description:
    "Read/rebind the durable planning pointer for the current delivery manager. Releases a stale epoch lease. A submitted stage locates the existing conversation; resume never authorizes submit_prompt and does not schedule or drive a GUI.",
  parameters: RestartInput,
  success: PlanningResult,
  failure: PlanningFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Resume persisted planning")
  .annotate(Tool.Destructive, true);
const toolkit = Toolkit.make(Commit, Restart);

const present = (result: MissionPlanningResult): typeof PlanningResult.Type => {
  if (Result.isFailure(result))
    return {
      status: result.failure._tag === "MissionPlanningDeny" ? "deny" : "hold",
      action: result.failure.action,
      reasons: result.failure.reasons,
      thisCallWrote: false,
      recordPersisted: null,
      sideEffectAuthorized: false,
      submitAuthorized: false,
      durableGuiLease: "unknown",
      record: null,
      reservation: null,
    };
  const outcome = result.success;
  return {
    status: outcome.persistence,
    action: outcome.decision.action,
    reasons: outcome.decision.reasons,
    thisCallWrote: outcome.thisCallWrote,
    recordPersisted: outcome.recordPersisted,
    sideEffectAuthorized: outcome.sideEffectAuthorized,
    submitAuthorized: outcome.submitAuthorized,
    durableGuiLease: outcome.durableGuiLease,
    record: outcome.record,
    reservation: outcome.reservation,
  };
};
const failure = (error: { readonly _tag: string; readonly code?: string }) =>
  new PlanningFailure({
    code:
      error.code === "planning_unavailable"
        ? "planning_unavailable"
        : error._tag === "MissionPlanningStoreError"
          ? "persistence"
          : "scope_denied",
  });

const handlers = toolkit.toLayer({
  mission_planning_commit: (input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const runtime = yield* Combined.CombinedMissionRuntime;
      return yield* runtime
        .withRequest(scope, { missionId: input.missionId, role: "delivery" }, (request) =>
          request.commitPlanning({ commandId: input.commandId, event: input.event }),
        )
        .pipe(Effect.map(present), Effect.mapError(failure));
    }),
  mission_planning_resume: (input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const runtime = yield* Combined.CombinedMissionRuntime;
      return yield* runtime
        .withRequest(scope, { missionId: input.missionId, role: "delivery" }, (request) =>
          request.restartPlanning({ commandId: input.commandId, planningId: input.planningId }),
        )
        .pipe(Effect.map(present), Effect.mapError(failure));
    }),
});

export const layerOptional = Layer.unwrap(
  Effect.serviceOption(Combined.CombinedMissionRuntime).pipe(
    Effect.map((runtime) =>
      Option.isNone(runtime)
        ? Layer.empty
        : McpServer.toolkit(toolkit).pipe(
            Layer.provide(handlers),
            Layer.provide(Layer.succeed(Combined.CombinedMissionRuntime, runtime.value)),
          ),
    ),
  ),
);

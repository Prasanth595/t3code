import { CommandId, MissionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { MissionCompletionSelector } from "../../../../packages/contracts/src/missionCompletion.ts";
import * as Combined from "../orchestration-v2/CombinedMissionRuntime.ts";
import * as Invocation from "./McpInvocationContext.ts";

const Role = Schema.Literals(["delivery", "retro"]);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Scope = { missionId: MissionId, role: Role };
const Reservation = { ...Scope, reservationId: Id };
class Failure extends Schema.TaggedError<Failure>()("MissionLifecycleMcpFailure", {
  code: Schema.Literals([
    "authority_unavailable",
    "scope_denied",
    "unavailable",
    "request_conflict",
  ]),
}) {}
const dependencies = [Invocation.McpInvocationContext, Combined.CombinedMissionRuntime];
const tool = <const N extends string, S extends Schema.Top>(
  name: N,
  description: string,
  parameters: S,
) =>
  Tool.make(name, {
    description,
    parameters,
    success: Schema.Unknown,
    failure: Failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Strict, true);
const toolkit = Toolkit.make(
  tool(
    "mission_manager_state",
    "Reread the canonical mission, accepted decisions, attempts, pending reviews and role lineage after restart or adoption. Only the current logical manager may read through this consumer.",
    Schema.Struct(Scope),
  ),
  tool(
    "mission_manager_reserve",
    "Evaluate the configured project local day and reserve one durable successor with an immutable handoff. Runtime observations supply all safety facts; no schedule or fleet is activated. Unknown process/GUI facts hold. Retry recovers the same unresolved successor.",
    Schema.Struct({ ...Scope, commandId: CommandId, expectedRevision: Revision }),
  ),
  tool(
    "mission_manager_standby",
    "Create or recover the reserved inert successor through ThreadLaunchService. Standby has no provider turn or dispatch authority.",
    Schema.Struct(Reservation),
  ),
  tool(
    "mission_manager_advance",
    "Record a verified standby, quiescence, routing ACK or retirement from real runtime observations. Quiesce holds while the coordinator turn, GUI or unknown writers remain. Use transfer for cutover and activation.",
    Schema.Struct({
      ...Reservation,
      commandId: CommandId,
      expectedRevision: Revision,
      step: Schema.Literals(["standby", "quiesce", "routing", "retire"]),
    }),
  ),
  tool(
    "mission_manager_transfer",
    "CAS the quiesced reservation's role epoch, then queue adoption to the current successor using a stable wake key. Routing requires the successor's own durable ACK. No worker sessions are stopped.",
    Schema.Struct({ ...Reservation, commandId: CommandId, expectedRevision: Revision }),
  ),
  tool(
    "mission_manager_retire",
    "After confirmed successor routing, release only the incumbent's provider sessions and MCP credentials. Dependent workers or an active incumbent hold retirement. Then record retire with mission_manager_advance.",
    Schema.Struct(Reservation),
  ),
  tool(
    "mission_completion_wake",
    "Derive an exact persisted completion and coalesce a wake to its current logical role and epoch. Preserves awaiting-review state; never accepts or integrates a result.",
    Schema.Struct({ ...Scope, selector: MissionCompletionSelector }),
  ),
  tool(
    "mission_retro_replay",
    "Execute an owner-configured replay plan in private sandboxes, independently grade old/new failure, positive and negative fixtures, then persist the hash-bound evaluation on the canonical mission. No caller executable, route, evidence or grading assertions are accepted. Deterministic evidence proves no model effect.",
    Schema.Struct({
      missionId: MissionId,
      commandId: CommandId,
      expectedRevision: Revision,
      evaluationId: Id,
      planId: Id,
    }),
  ),
);
const failure = (e: { readonly _tag: string }) => {
  const code = "code" in e ? e.code : undefined;
  return new Failure({
    code:
      code === "authority_unavailable" || code === "scope_denied" || code === "request_conflict"
        ? code
        : "unavailable",
  });
};
const invoke = <A, E extends { readonly _tag: string }>(
  input: { readonly missionId: string; readonly role: "delivery" | "retro" },
  use: (request: Combined.CombinedMissionRequest) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* Invocation.McpInvocationContext;
    const runtime = yield* Combined.CombinedMissionRuntime;
    return yield* runtime.withRequest(scope, input, use).pipe(Effect.mapError(failure));
  });
const handlers = toolkit.toLayer({
  mission_manager_state: (input) => invoke(input, (r) => r.readState),
  mission_manager_reserve: (input) =>
    invoke(input, (r) =>
      r.reserveRotation({ commandId: input.commandId, expectedRevision: input.expectedRevision }),
    ),
  mission_manager_standby: (input) => invoke(input, (r) => r.launchStandby(input.reservationId)),
  mission_manager_advance: (input) =>
    invoke(input, (r) =>
      r.advance({
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        reservationId: input.reservationId,
        step: input.step,
      }),
    ),
  mission_manager_transfer: (input) =>
    invoke(input, (r) =>
      r.transferAndWake({
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        reservationId: input.reservationId,
      }),
    ),
  mission_manager_retire: (input) => invoke(input, (r) => r.cleanupIncumbent(input.reservationId)),
  mission_completion_wake: (input) => invoke(input, (r) => r.wakeCompletion(input.selector)),
  mission_retro_replay: (input) =>
    invoke({ missionId: input.missionId, role: "retro" }, (r) =>
      r.replayAndRecord({
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        evaluationId: input.evaluationId,
        planId: input.planId,
      }),
    ),
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

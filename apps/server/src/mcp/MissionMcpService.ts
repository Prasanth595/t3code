import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionAuthorityProvenance,
  MissionCommand,
  MissionEpoch,
  MissionId,
  NonNegativeInt,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as MissionCommands from "../orchestration-v2/MissionCommands.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * Thin typed MCP get/execute adapter for the existing MissionService. The
 * adapter owns no SQL, CAS, event, receipt, or replay logic of its own: every
 * request resolves a trusted authority, builds one MissionService under that
 * authority on the same injected SQL/repos, and delegates. Root owns runtime
 * composition and wires the real authority resolver plus tool activation.
 */

/** Sanitized bounded failures: fixed messages, no SQL, causes, or credentials. */
export class MissionMcpFailure extends Schema.TaggedError<MissionMcpFailure>()(
  "MissionMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_credential_required",
      "authority_unavailable",
      "scope_denied",
      "request_conflict",
      "plan_rejected",
      "invalid_request",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

export type MissionMcpOperation = "read" | "commit";

export interface MissionMcpAuthorityRequest {
  /** The actual caller scope: never a caller-supplied team, env, or controller. */
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly operation: MissionMcpOperation;
  readonly missionId: MissionId;
  /**
   * Strictly decoded proposed mission for commit only. Optional so existing
   * custom resolvers keep compiling; the real resolver fails closed without
   * it on commit, and reads never carry it. The proposed team, environment,
   * and controller are never authority evidence: the resolver compares them
   * against trusted policy and current project rows instead.
   */
  readonly proposedMission?: Mission | undefined;
}

/**
 * Authenticated facts the trusted server resolver derives from the caller
 * scope, operation, and mission id: verified NoFun company, team,
 * environment, and the current caller-role binding. Never echoed from a
 * proposed command body. `company`/`companyVerified`/`bindingVerified` are
 * server-derived evidence, not caller strings: a resolver that cannot verify
 * them must fail its own resolution instead of returning unverified facts.
 */
export interface MissionMcpAuthorityFacts {
  readonly company: "nofun";
  readonly companyVerified: true;
  readonly bindingVerified: true;
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly controllerThreadId: ThreadId;
}

/**
 * Trusted server resolver port. Deliberately has no default layer: a missing
 * resolver stays fail-closed (authority_unavailable), never an installed
 * capability claim. The request carries only scope, operation, and mission
 * id; arbitrary caller callbacks and MissionService instances are not
 * accepted as authority.
 */
export class MissionMcpAuthorityPort extends Context.Service<
  MissionMcpAuthorityPort,
  {
    readonly resolve: (
      request: MissionMcpAuthorityRequest,
    ) => Effect.Effect<MissionMcpAuthorityFacts, MissionMcpFailure>;
  }
>()("t3/mcp/MissionMcpService/MissionMcpAuthorityPort") {}

export const MissionMcpGetInput = Schema.Struct({ id: MissionId });
export type MissionMcpGetInput = typeof MissionMcpGetInput.Type;

export const MissionMcpGetResult = Schema.Struct({
  status: Schema.Literals(["found", "missing"]),
  mission: Schema.NullOr(Mission),
});
export type MissionMcpGetResult = typeof MissionMcpGetResult.Type;

/**
 * Execute parameters reuse the leaf create/replace command fields, flattened
 * into one object-root struct: McpServer refuses a bare union whose JSON
 * Schema has no object root. The service still decodes the strict leaf
 * MissionCommand union (excess properties rejected) before delegating.
 */
export const MissionMcpExecuteInput = Schema.Struct({
  type: Schema.Literals(["mission.create", "mission.replace"]),
  commandId: CommandId,
  mission: Mission,
  expectedRevision: Schema.optional(NonNegativeInt),
  epoch: Schema.optional(MissionEpoch),
  authority: Schema.optional(MissionAuthorityProvenance),
});
export type MissionMcpExecuteInput = typeof MissionMcpExecuteInput.Type;

export const MissionMcpExecuteResult = Schema.Struct({
  missionId: MissionId,
  commandId: CommandId,
  committed: Schema.Boolean,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted"]),
});
export type MissionMcpExecuteResult = typeof MissionMcpExecuteResult.Type;

export class MissionMcpService extends Context.Service<
  MissionMcpService,
  {
    readonly get: (
      scope: McpInvocationContext.McpInvocationScope,
      input: unknown,
    ) => Effect.Effect<MissionMcpGetResult, MissionMcpFailure>;
    readonly execute: (
      scope: McpInvocationContext.McpInvocationScope,
      input: unknown,
    ) => Effect.Effect<MissionMcpExecuteResult, MissionMcpFailure>;
  }
>()("t3/mcp/MissionMcpService") {}

const decodeGetInput = Schema.decodeUnknownEffect(MissionMcpGetInput, {
  onExcessProperty: "error",
});
const decodeCommand = Schema.decodeUnknownEffect(MissionCommand, {
  onExcessProperty: "error",
});

const invalidRequest = () =>
  new MissionMcpFailure({
    code: "invalid_request",
    message: "The mission request did not match the expected shape.",
  });

/**
 * Detach the decoded proposed mission from caller-mutable memory before any
 * yield point: serialize through the service's own encoding and decode it
 * back, so later in-place edits to the caller's object cannot change the
 * bindings the authority verified or the command that commits.
 */
const encodeMission = Schema.encodeEffect(Mission);
const decodeMissionSnapshot = Schema.decodeUnknownEffect(Mission);

const snapshotProposedMission = (
  mission: Mission,
): Effect.Effect<Mission, MissionMcpFailure> =>
  encodeMission(mission).pipe(Effect.flatMap(decodeMissionSnapshot), Effect.mapError(invalidRequest));

const unavailable = () =>
  new MissionMcpFailure({
    code: "unavailable",
    message: "Mission storage is unavailable.",
  });

const scopeDenied = () =>
  new MissionMcpFailure({
    code: "scope_denied",
    message: "The mission is outside the caller's team, environment, or manager role.",
  });

const mapServiceFailure = (
  error: MissionService.MissionServiceError | MissionCommands.MissionPlanError,
): MissionMcpFailure => {
  if (error._tag === "MissionPlanError") {
    // The code is from the planner's closed literal union, so this stays bounded.
    return new MissionMcpFailure({
      code: "plan_rejected",
      message: `The mission command was rejected (${error.code}).`,
    });
  }
  switch (error.category) {
    case "scope_denied":
      return scopeDenied();
    case "request_conflict":
      return new MissionMcpFailure({
        code: "request_conflict",
        message: "The command id was already used for a different mission request.",
      });
    default:
      return unavailable();
  }
};

interface CanonicalBinding {
  readonly team_id: string;
  readonly authority_environment_id: string;
  readonly manager_thread: string | null;
  readonly manager_epoch: number | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  const innerBase = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.succeed(EventStore.OrchestrationEventStore, events),
    Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, receipts),
  );

  /** Orchestration capability plus a live thread caller, before any read or receipt lookup. */
  const readScope = (
    scope: McpInvocationContext.McpInvocationScope,
  ): Effect.Effect<McpInvocationContext.McpThreadInvocationScope, MissionMcpFailure> => {
    if (!scope.capabilities.has("orchestration")) {
      return Effect.fail(
        new MissionMcpFailure({
          code: "capability_denied",
          message: "This credential cannot read or change missions.",
        }),
      );
    }
    if (scope.thread === undefined) {
      return Effect.fail(
        new MissionMcpFailure({
          code: "thread_credential_required",
          message:
            "Mission tools act as the calling T3 thread, so they need an agent running inside T3 Code. This MCP client signed in from outside a thread.",
        }),
      );
    }
    return Effect.succeed(scope as McpInvocationContext.McpThreadInvocationScope);
  };

  const resolveFacts = Effect.fn("MissionMcpService.resolveFacts")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
    operation: MissionMcpOperation,
    missionId: MissionId,
    proposedMission?: Mission,
  ): Effect.fn.Return<MissionMcpAuthorityFacts, MissionMcpFailure> {
    const port = yield* Effect.serviceOption(MissionMcpAuthorityPort);
    if (Option.isNone(port)) {
      return yield* new MissionMcpFailure({
        code: "authority_unavailable",
        message: "No mission authority resolver is installed, so the request stays denied.",
      });
    }
    const facts = yield* port.value.resolve({ scope, operation, missionId, proposedMission }).pipe(
      Effect.mapError((error) => new MissionMcpFailure({
        code: error.code,
        message: "The mission authority resolver denied the request.",
      })),
    );
    // Bind resolver output to the actual caller and to verified NoFun facts:
    // a resolver may not move a request to another environment, hand it
    // another thread's control, or claim an unverified company/binding.
    if (
      facts.company !== "nofun" ||
      facts.companyVerified !== true ||
      facts.bindingVerified !== true ||
      facts.environmentId !== scope.environmentId ||
      facts.controllerThreadId !== scope.thread.threadId
    ) {
      return yield* scopeDenied();
    }
    return facts;
  });

  /**
   * Current role and canonical mission checked BEFORE get/replay: team and
   * environment come from the durable row (never the proposed command), and
   * the delivery manager must be the authenticated caller thread. A stale
   * caller is denied before any mission content is decoded or disclosed.
   */
  const assertCurrentRole = Effect.fn("MissionMcpService.assertCurrentRole")(function* (
    facts: MissionMcpAuthorityFacts,
    missionId: MissionId,
  ): Effect.fn.Return<void, MissionMcpFailure> {
    const rows = yield* sql<CanonicalBinding>`
      SELECT team_id, authority_environment_id,
        json_extract(snapshot_json, '$.managers.delivery.threadId') AS manager_thread,
        json_extract(snapshot_json, '$.managers.delivery.epoch') AS manager_epoch
      FROM projection_missions
      WHERE mission_id = ${missionId}
    `.pipe(Effect.mapError(() => unavailable()));
    const row = rows[0];
    if (row === undefined) return;
    if (row.team_id !== facts.teamId || row.authority_environment_id !== facts.environmentId) {
      return yield* scopeDenied();
    }
    if (row.manager_thread !== facts.controllerThreadId || row.manager_epoch === null) {
      return yield* new MissionMcpFailure({
        code: "scope_denied",
        message: "Only the mission's current delivery manager thread may read or change it.",
      });
    }
  });

  /** One MissionService per request under this request's authority: never shared across callers. */
  const innerService = Effect.fn("MissionMcpService.innerService")(function* (
    facts: MissionMcpAuthorityFacts,
  ): Effect.fn.Return<MissionService.MissionService["Service"], MissionMcpFailure> {
    const innerLayer = MissionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          innerBase,
          Layer.succeed(MissionService.MissionAuthority, {
            teamId: facts.teamId,
            environmentId: facts.environmentId,
            controllerThreadId: facts.controllerThreadId,
          }),
        ),
      ),
    );
    return yield* Effect.provide(MissionService.MissionService, innerLayer).pipe(
      Effect.mapError(() => unavailable()),
    );
  });

  const get = Effect.fn("MissionMcpService.get")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: unknown,
  ): Effect.fn.Return<MissionMcpGetResult, MissionMcpFailure> {
    const threadScope = yield* readScope(scope);
    const decoded = yield* decodeGetInput(input).pipe(Effect.mapError(invalidRequest));
    const facts = yield* resolveFacts(threadScope, "read", decoded.id);
    // Role check, content read, and role recheck run in one transaction on
    // the same SQL handle, so a manager rotation that commits in between
    // cannot disclose content to the retired manager.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* assertCurrentRole(facts, decoded.id);
          const inner = yield* innerService(facts);
          const found = yield* inner.get(decoded.id).pipe(Effect.mapError(mapServiceFailure));
          yield* assertCurrentRole(facts, decoded.id);
          return Option.isSome(found)
            ? { status: "found" as const, mission: found.value }
            : { status: "missing" as const, mission: null };
        }),
      )
      .pipe(Effect.mapError((error) => (error._tag === "MissionMcpFailure" ? error : unavailable())));
  });

  const execute = Effect.fn("MissionMcpService.execute")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: unknown,
  ): Effect.fn.Return<MissionMcpExecuteResult, MissionMcpFailure> {
    const threadScope = yield* readScope(scope);
    const command = yield* decodeCommand(input).pipe(Effect.mapError(invalidRequest));
    // Snapshot the decoded proposal before the first I/O below, then resolve
    // and commit with that same snapshot: the caller's object stays mutable.
    const proposedMission = yield* snapshotProposedMission(command.mission);
    const committedCommand = { ...command, mission: proposedMission };
    const facts = yield* resolveFacts(threadScope, "commit", proposedMission.id, proposedMission);
    yield* assertCurrentRole(facts, proposedMission.id);
    const inner = yield* innerService(facts);
    // MissionService.execute already unwraps its transaction Result into the
    // error channel; capture it explicitly so plan failures map to one fixed
    // bounded failure instead of leaking through.
    const outcome = yield* inner.execute(committedCommand).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      return yield* mapServiceFailure(outcome.failure);
    }
    return {
      missionId: proposedMission.id,
      commandId: committedCommand.commandId,
      committed: outcome.success.committed,
      resultSequence: outcome.success.receipt.resultSequence,
      status: "accepted" as const,
    };
  });

  return MissionMcpService.of({ get, execute });
});

export const layer = Layer.effect(MissionMcpService, make);

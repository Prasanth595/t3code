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
import type { MissionRetroReportReceiveCommand } from "../orchestration-v2/MissionRetroReportStore.ts";

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

export type MissionMcpAuthorityRequest =
  | {
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
      /** Entire detached command and invocation identity, supplied by the adapter. */
      readonly command?: MissionCommand | undefined;
      readonly requestKey?: object | undefined;
    }
  | {
      readonly scope: McpInvocationContext.McpThreadInvocationScope;
      readonly operation: "retro-report-receive";
      readonly missionId: MissionId;
      readonly command: MissionRetroReportReceiveCommand;
      readonly requestKey: object;
      readonly proposedMission?: never;
    };

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
  /** Required by the MCP adapter at runtime; plain facts never authorize I/O. */
  readonly transactionGuard?: MissionService.MissionTransactionGuard | undefined;
}

/**
 * Trusted server resolver port. Deliberately has no default layer: a missing
 * resolver stays fail-closed (authority_unavailable). Its opaque guard is
 * server-only: public tool parameters cannot supply a callback or authority
 * handle, and the owning service checks its SQL and request binding.
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

const encodeCommandSnapshot = Schema.encodeEffect(Schema.fromJsonString(MissionCommand));
const decodeCommandSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(MissionCommand));

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

const snapshotProposedMission = (mission: Mission): Effect.Effect<Mission, MissionMcpFailure> =>
  encodeMission(mission).pipe(
    Effect.flatMap(decodeMissionSnapshot),
    Effect.mapError(invalidRequest),
  );

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
    requestKey: object,
    proposedMission?: Mission,
    command?: MissionCommand,
  ): Effect.fn.Return<MissionMcpAuthorityFacts, MissionMcpFailure> {
    const port = yield* Effect.serviceOption(MissionMcpAuthorityPort);
    if (Option.isNone(port)) {
      return yield* new MissionMcpFailure({
        code: "authority_unavailable",
        message: "No mission authority resolver is installed, so the request stays denied.",
      });
    }
    const facts = yield* port.value
      .resolve({ scope, operation, missionId, proposedMission, command, requestKey })
      .pipe(
        Effect.mapError(
          (error) =>
            new MissionMcpFailure({
              code: error.code,
              message: "The mission authority resolver denied the request.",
            }),
        ),
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
    if (facts.transactionGuard === undefined) {
      return yield* new MissionMcpFailure({
        code: "authority_unavailable",
        message: "A current transaction authority guard is required.",
      });
    }
    return { ...facts };
  });

  /** One MissionService per request under this request's authority: never shared across callers. */
  const innerService = Effect.fn("MissionMcpService.innerService")(function* (
    facts: MissionMcpAuthorityFacts,
    requestKey: object,
  ): Effect.fn.Return<MissionService.MissionService["Service"], MissionMcpFailure> {
    const innerLayer = Layer.fresh(MissionService.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          innerBase,
          Layer.succeed(MissionService.MissionAuthority, {
            teamId: facts.teamId,
            environmentId: facts.environmentId,
            controllerThreadId: facts.controllerThreadId,
            transactionGuard: facts.transactionGuard,
            requestKey,
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
    const caller = {
      ...scope,
      thread: scope.thread === undefined ? undefined : { ...scope.thread },
      capabilities: new Set(scope.capabilities),
    };
    const requestKey = {};
    const threadScope = yield* readScope(caller);
    const decoded = yield* decodeGetInput(input).pipe(Effect.mapError(invalidRequest));
    const facts = yield* resolveFacts(threadScope, "read", decoded.id, requestKey);
    const inner = yield* innerService(facts, requestKey);
    const found = yield* inner.get(decoded.id).pipe(Effect.mapError(mapServiceFailure));
    return Option.isSome(found)
      ? { status: "found" as const, mission: found.value }
      : { status: "missing" as const, mission: null };
  });

  const execute = Effect.fn("MissionMcpService.execute")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: unknown,
  ): Effect.fn.Return<MissionMcpExecuteResult, MissionMcpFailure> {
    const caller = {
      ...scope,
      thread: scope.thread === undefined ? undefined : { ...scope.thread },
      capabilities: new Set(scope.capabilities),
    };
    const requestKey = {};
    const threadScope = yield* readScope(caller);
    const decoded = yield* decodeCommand(input).pipe(Effect.mapError(invalidRequest));
    // Decode strictly before serialization so even excess undefined fields
    // remain invalid; detach all accepted fields before the first I/O.
    const command = yield* encodeCommandSnapshot(decoded).pipe(
      Effect.flatMap(decodeCommandSnapshot),
      Effect.mapError(invalidRequest),
    );
    // Snapshot the decoded proposal before the first I/O below, then resolve
    // and commit with that same snapshot: the caller's object stays mutable.
    const proposedMission = yield* snapshotProposedMission(command.mission);
    const committedCommand = { ...command, mission: proposedMission };
    const facts = yield* resolveFacts(
      threadScope,
      "commit",
      proposedMission.id,
      requestKey,
      proposedMission,
      committedCommand,
    );
    const inner = yield* innerService(facts, requestKey);
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

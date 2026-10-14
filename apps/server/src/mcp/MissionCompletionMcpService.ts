// Per-invocation source-only completion-route MCP consumer.
//
// Resolves one strictly decoded completion selector through the actual
// opaque mission authority into a candidate or finite hold, inside the
// owning SQL transaction. Mirrors MissionRetroReportMcpService: the actual
// invocation scope is snapshotted, the cloned selector is strictly decoded
// before any I/O, orchestration capability plus a thread-only credential
// are required, and a missing authority port stays a finite
// authority_unavailable. The minted opaque guard is verified before the
// resolver reads, then a fresh resolver is built per invocation over the
// SAME SqlClient with the facts, handle, and request key. No
// transport/global wiring, no wake, no writes. Root owns composition.
import { MissionId } from "../../../../packages/contracts/src/mission.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  decodeMissionCompletionSelector,
  type MissionCompletionSelector,
} from "../../../../packages/contracts/src/missionCompletion.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as Resolver from "../orchestration-v2/MissionCompletionRouteResolver.ts";
import type { CompletionRouteDecision } from "../orchestration-v2/MissionCompletionRouting.ts";
import type * as Invocation from "./McpInvocationContext.ts";
import * as MissionMcp from "./MissionMcpService.ts";

export class MissionCompletionMcpService extends Context.Service<
  MissionCompletionMcpService,
  {
    readonly resolve: (
      actualScope: Invocation.McpInvocationScope,
      unknownSelector: unknown,
    ) => Effect.Effect<CompletionRouteDecision, MissionMcp.MissionMcpFailure>;
  }
>()("t3/mcp/MissionCompletionMcpService") {}

const invalidRequest = () =>
  new MissionMcp.MissionMcpFailure({
    code: "invalid_request",
    message: "The completion selector did not match the expected shape.",
  });
const denied = () =>
  new MissionMcp.MissionMcpFailure({
    code: "scope_denied",
    message: "The current completion manager is not authorized to read this route.",
  });
const unavailable = () =>
  new MissionMcp.MissionMcpFailure({
    code: "unavailable",
    message: "Completion route storage is unavailable.",
  });

const mapResolverError = (error: Resolver.MissionCompletionRouteResolverError) => {
  switch (error.category) {
    case "scope_denied":
      return denied();
    case "request_conflict":
      return invalidRequest();
    default:
      return unavailable();
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authorityPort = yield* Effect.serviceOption(MissionMcp.MissionMcpAuthorityPort);
  const resolve = Effect.fn("MissionCompletionMcpService.resolve")(function* (
    actualScope: Invocation.McpInvocationScope,
    unknownSelector: unknown,
  ): Effect.fn.Return<CompletionRouteDecision, MissionMcp.MissionMcpFailure> {
    const scope = {
      ...actualScope,
      thread: actualScope.thread === undefined ? undefined : { ...actualScope.thread },
      client: actualScope.client === undefined ? undefined : { ...actualScope.client },
      capabilities: new Set(actualScope.capabilities),
    };
    const detached = yield* Effect.try({
      try: () => structuredClone(unknownSelector),
      catch: () => invalidRequest(),
    });
    const selector: MissionCompletionSelector = yield* decodeMissionCompletionSelector(detached).pipe(
      Effect.mapError(() => invalidRequest()),
    );
    if (!scope.capabilities.has("orchestration"))
      return yield* new MissionMcp.MissionMcpFailure({
        code: "capability_denied",
        message: "This credential cannot read completion routes.",
      });
    if (scope.thread === undefined || scope.client !== undefined)
      return yield* new MissionMcp.MissionMcpFailure({
        code: "thread_credential_required",
        message: "Completion route reads require an authenticated T3 thread credential.",
      });
    if (Option.isNone(authorityPort))
      return yield* new MissionMcp.MissionMcpFailure({
        code: "authority_unavailable",
        message: "A current completion authority resolver is required.",
      });
    const requestKey = {};
    const missionId = MissionId.make(selector.missionId);
    const facts = yield* authorityPort.value
      .resolve({
        scope: { ...scope, thread: scope.thread },
        operation: "completion-route-read",
        missionId,
        command: selector,
        requestKey,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new MissionMcp.MissionMcpFailure({
              code: error.code,
              message: "The completion authority resolver denied the request.",
            }),
        ),
      );
    if (
      facts.company !== "nofun" ||
      facts.companyVerified !== true ||
      facts.bindingVerified !== true ||
      facts.environmentId !== scope.environmentId ||
      facts.controllerThreadId !== scope.thread.threadId ||
      facts.transactionGuard === undefined
    )
      return yield* denied();
    const authority = {
      teamId: facts.teamId,
      environmentId: facts.environmentId,
      controllerThreadId: facts.controllerThreadId,
      transactionGuard: facts.transactionGuard,
      requestKey,
    };
    // Facts or copied handles cannot authorize even the first private read.
    yield* MissionService.MissionTransactionGuard.check({
      sql,
      authority,
      request: { operation: "completion-route-read", missionId, command: selector },
    }).pipe(Effect.mapError(() => denied()));
    // Fresh resolver per invocation over the SAME SqlClient and the verified
    // facts, handle, and key. The private callback port is never provided,
    // so the opaque guard is the only currency source.
    const base = Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(MissionService.MissionAuthority, authority),
    );
    const inner = Layer.fresh(Resolver.layer).pipe(Layer.provide(base));
    return yield* Effect.gen(function* () {
      const resolver = yield* Resolver.MissionCompletionRouteResolver;
      return yield* resolver.resolve(structuredClone(selector));
    }).pipe(Effect.provide(inner), Effect.mapError(mapResolverError));
  });
  return MissionCompletionMcpService.of({ resolve });
});

/** Root supplies composition; no registration, default, or activation. */
export const layer = Layer.effect(MissionCompletionMcpService, make);
